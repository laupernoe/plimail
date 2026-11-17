// Settings → Server filters: the account's Sieve scripts over ManageSieve (RFC 5804). Plimail
// writes only its own script, `plimail`; another script is replaced, or made inactive, only when
// the request says the user confirmed it. Every script is checked by the server (CHECKSCRIPT)
// before it is stored.

import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { findOwnedAccount } from '../services/ownership.js';
import { consume } from '../services/rateLimiter.js';
import { SieveError } from '../services/manageSieve.js';
import { SIEVE_ACCOUNT_COLUMNS, withAccountSieve } from '../services/sieveAccount.js';
import { PLIMAIL_SCRIPT, buildPlimailScript, readPlimailMeta, validateRules } from '../services/sieveScript.js';
import { resolveTrashFolder } from '../utils/mailUtils.js';

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_NAME = 128;
// Each request is a login on the user's mail server: a few a minute is plenty for the editor.
const SESSIONS_PER_MINUTE = 20;

router.param('accountId', (req, res, next, value) => (UUID_RE.test(value) ? next() : res.status(404).json({ error: 'Not found' })));

// Codes the client turns into a message. 'unavailable' covers the server not offering Sieve.
const UNAVAILABLE = new Set(['unreachable', 'timeout', 'no_starttls', 'tls_failed', 'no_plain', 'closed', 'protocol']);

function sieveFailure(res, err) {
  if (!(err instanceof SieveError)) throw err;
  if (err.code === 'rejected') return res.status(422).json({ error: err.message, code: 'sieve_rejected', serverCode: err.serverCode });
  if (err.code === 'auth_failed') return res.status(502).json({ error: err.message, code: 'sieve_auth_failed' });
  if (['oauth_unsupported', 'no_password', 'host_refused'].includes(err.code)) {
    return res.status(400).json({ error: err.message, code: `sieve_${err.code}` });
  }
  return res.status(502).json({ error: err.message, code: UNAVAILABLE.has(err.code) ? 'sieve_unavailable' : 'sieve_failed' });
}

async function loadAccount(req, res) {
  const account = await findOwnedAccount(req.session.userId, req.params.accountId, { columns: SIEVE_ACCOUNT_COLUMNS, protocol: 'imap' });
  if (!account) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  const limit = await consume(`sieve:${req.session.userId}`, SESSIONS_PER_MINUTE, 60_000);
  if (limit.limited) {
    res.status(429).json({ error: 'Too many requests to the mail server; try again in a minute', code: 'rate_limited' });
    return null;
  }
  return account;
}

const validName = name => typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME
  && ![...name].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

function scriptFromBody(content) {
  if (typeof content !== 'string') return { error: 'Script content is required' };
  if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) return { error: 'Script is too large' };
  return { content: content.replace(/\r?\n/g, '\r\n') };
}

// The state the page shows: whether the server speaks Sieve, its scripts and which is active,
// and Plimail's own script with its rules when Plimail wrote it.
router.get('/:accountId', async (req, res) => {
  const account = await loadAccount(req, res);
  if (!account) return undefined;
  try {
    const state = await withAccountSieve(account, async (session) => {
      const scripts = await session.listScripts();
      const own = scripts.find(s => s.name === PLIMAIL_SCRIPT);
      const content = own ? await session.getScript(PLIMAIL_SCRIPT) : null;
      const active = scripts.find(s => s.active)?.name ?? null;
      const meta = content != null ? readPlimailMeta(content) : null;
      return {
        supported: true,
        implementation: session.capabilities.implementation,
        extensions: session.capabilities.sieve,
        scripts,
        active,
        otherActive: active && active !== PLIMAIL_SCRIPT ? active : null,
        plimail: { exists: !!own, managed: !!meta, rules: meta?.rules ?? [], content },
      };
    });
    return res.json(state);
  } catch (err) {
    if (err instanceof SieveError && (UNAVAILABLE.has(err.code) || err.code === 'oauth_unsupported')) {
      return res.json({ supported: false, reason: err.code === 'oauth_unsupported' ? 'oauth' : err.code });
    }
    return sieveFailure(res, err);
  }
});

router.get('/:accountId/scripts/:name', async (req, res) => {
  if (!validName(req.params.name)) return res.status(400).json({ error: 'Invalid script name' });
  const account = await loadAccount(req, res);
  if (!account) return undefined;
  try {
    const content = await withAccountSieve(account, session => session.getScript(req.params.name));
    return res.json({ name: req.params.name, content });
  } catch (err) {
    return sieveFailure(res, err);
  }
});

router.post('/:accountId/check', async (req, res) => {
  const script = scriptFromBody(req.body?.content);
  if (script.error) return res.status(400).json({ error: script.error });
  const account = await loadAccount(req, res);
  if (!account) return undefined;
  try {
    return res.json(await withAccountSieve(account, session => session.checkScript(script.content)));
  } catch (err) {
    return sieveFailure(res, err);
  }
});

// Stores a script after the server checked it. Plimail's own script is stored freely; any
// other name only with `overwrite: true` when it exists, since Plimail did not write it.
// `activate` makes it the active script; when another one is active that needs `replaceActive`,
// otherwise the answer is 409 'other_active' and nothing is stored.
// `content` is the script, or a function of the session that builds it. `fromRules`: the
// content replaces Plimail's script with one built from rules, which needs `overwrite` when the
// stored one was edited by hand.
async function storeScript(res, account, { name, content: makeContent, activate, overwrite, replaceActive, fromRules = false }) {
  try {
    return await withAccountSieve(account, async (session) => {
      const content = typeof makeContent === 'function' ? makeContent(session) : makeContent;
      const scripts = await session.listScripts();
      const exists = scripts.some(s => s.name === name);
      const active = scripts.find(s => s.active)?.name ?? null;
      if (exists && name !== PLIMAIL_SCRIPT && !overwrite) {
        return res.status(409).json({ error: `The script "${name}" was not written by Plimail`, code: 'not_plimail', name });
      }
      if (fromRules && exists && !overwrite && !readPlimailMeta(await session.getScript(name))) {
        return res.status(409).json({ error: 'The Plimail script was edited by hand', code: 'plimail_edited' });
      }
      if (activate && active && active !== name && !replaceActive) {
        return res.status(409).json({ error: `"${active}" is the active script`, code: 'other_active', active });
      }
      const { warnings } = await session.checkScript(content);
      await session.putScript(name, content);
      if (activate && active !== name) await session.setActive(name);
      return res.json({ ok: true, warnings, active: activate ? name : active });
    });
  } catch (err) {
    if (err.code === 'extension_missing' || err.code === 'no_trash') return res.status(400).json({ error: err.message, code: err.code });
    return sieveFailure(res, err);
  }
}

// The rules editor: Plimail's script, rebuilt from the rules.
router.put('/:accountId/rules', async (req, res) => {
  const { activate = true, replaceActive = false, overwrite = false } = req.body || {};
  const checked = validateRules(req.body?.rules);
  if (checked.error) return res.status(400).json({ error: checked.error, index: checked.index, code: 'invalid_rule' });
  const account = await loadAccount(req, res);
  if (!account) return undefined;

  const folders = [...new Set(checked.rules.filter(r => r.action === 'move').map(r => r.folder))];
  if (folders.length) {
    const known = await query('SELECT path FROM folders WHERE account_id = $1 AND path = ANY($2)', [account.id, folders]);
    const knownPaths = new Set(known.rows.map(r => r.path));
    const unknown = folders.find(f => !knownPaths.has(f));
    if (unknown) return res.status(400).json({ error: `No folder named "${unknown}"`, code: 'unknown_folder' });
  }
  const trashFolder = checked.rules.some(r => r.action === 'delete')
    ? await resolveTrashFolder(account.id, account.folder_mappings)
    : null;

  return storeScript(res, account, {
    name: PLIMAIL_SCRIPT,
    content: session => buildPlimailScript({ rules: checked.rules }, { extensions: session.capabilities.sieve, trashFolder }),
    activate: !!activate,
    replaceActive: !!replaceActive,
    overwrite: !!overwrite,
    fromRules: true,
  });
});

// The raw editor.
router.put('/:accountId/scripts/:name', async (req, res) => {
  if (!validName(req.params.name)) return res.status(400).json({ error: 'Invalid script name' });
  const script = scriptFromBody(req.body?.content);
  if (script.error) return res.status(400).json({ error: script.error });
  const account = await loadAccount(req, res);
  if (!account) return undefined;
  const { activate = false, overwrite = false, replaceActive = false } = req.body || {};
  return storeScript(res, account, {
    name: req.params.name, content: script.content, activate: !!activate, overwrite: !!overwrite, replaceActive: !!replaceActive,
  });
});

// Makes a script active, or none (name null). Taking over from a script Plimail did not write
// needs `replaceActive`, like a save.
router.post('/:accountId/active', async (req, res) => {
  const { name = null, replaceActive = false } = req.body || {};
  if (name !== null && !validName(name)) return res.status(400).json({ error: 'Invalid script name' });
  const account = await loadAccount(req, res);
  if (!account) return undefined;
  try {
    return await withAccountSieve(account, async (session) => {
      const scripts = await session.listScripts();
      const active = scripts.find(s => s.active)?.name ?? null;
      if (name !== null && !scripts.some(s => s.name === name)) return res.status(404).json({ error: 'No such script' });
      if (active && active !== name && active !== PLIMAIL_SCRIPT && !replaceActive) {
        return res.status(409).json({ error: `"${active}" is the active script`, code: 'other_active', active });
      }
      if (active !== name) await session.setActive(name ?? '');
      return res.json({ ok: true, active: name });
    });
  } catch (err) {
    return sieveFailure(res, err);
  }
});

export default router;
