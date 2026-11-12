import { publicFolderCounts } from '../services/folderStatus.js';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { encrypt } from '../services/encryption.js';
import { sanitizeSignature } from '../services/emailSanitizer.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { createKeyedSerializer } from '../utils/keyedSerializer.js';
import { isUuid, uuidParam } from '../utils/uuid.js';
import { normalizeAddressList } from '../utils/addressList.js';
import { reportConnect } from '../services/connectReport.js';
import { findOwnedAccount, findOwnedAlias } from '../services/ownership.js';
import { NEXT_ACCOUNT_SORT_ORDER, setAccountOrder } from '../services/accountOrder.js';

// Serialize an account's reconnect triggers so a rapid settings change (e.g. an
// enabled double-toggle) can't fire two overlapping disconnect→connect chains —
// connectAccount's in-progress guard would drop the second and leave the connection
// state inconsistent with the final DB value. Queued per account id.
const reconnectQueue = createKeyedSerializer();

const ALLOWED_IMAP_PORTS = new Set([143, 993]);
const ALLOWED_SMTP_PORTS = new Set([465, 587]);

function validatePort(port, allowed) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return `Port ${port} is not a valid port number`;
  }
  // When private/local hosts are explicitly allowed (e.g. Proton Mail Bridge on 1143/1025),
  // skip the whitelist — the operator has already opted into unrestricted host access.
  if (process.env.ALLOW_PRIVATE_IMAP_HOSTS === 'true') return null;
  if (!allowed.has(n)) {
    return `Port ${port} is not allowed. Allowed: ${[...allowed].join(', ')}`;
  }
  return null;
}

// Reject strings that contain characters that could inject extra email headers.
function hasHeaderInjectionChars(str) {
  return typeof str === 'string' && /[\r\n\0]/.test(str);
}

const router = Router();
router.use(requireAuth);
// Reject malformed UUID path params with a 400 before they reach a uuid-typed query (else the
// Postgres cast error surfaces as a 500). Every :id/:aliasId in this router is a UUID.
// A mailbox's icon (#376): exactly one emoji (a flag, a keycap or a joined sequence such as a
// family counts as one), or none. Returns { value } with null for none, or { error }.
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });
// The whole of it must be one emoji sequence: a flag (two regional indicators), a keycap, a tag
// flag (Scotland), or an emoji with an optional skin tone, joined (ZWJ) to more of the same. Only
// a grapheme count let in an emoji under a pile of combining marks, a letter keycap, invisible tag
// characters and plain text symbols such as ©.
const EMOJI = /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|(?!\p{Regional_Indicator})(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)$/u;
export function normalizeAccountIcon(icon) {
  if (icon === null || icon === undefined) return { value: null };
  if (typeof icon !== 'string') return { error: 'icon must be a string' };
  const value = icon.trim();
  if (!value) return { value: null };
  if (value.length > 32 || [...GRAPHEMES.segment(value)].length !== 1 || !EMOJI.test(value)) {
    return { error: 'icon must be a single emoji' };
  }
  return { value };
}

router.param('id', uuidParam('id'));
router.param('aliasId', uuidParam('aliasId'));

// Fields safe to return to the client, and the GET list's columns. Excludes credentials and tokens.
export const SAFE_FIELDS = [
  'id', 'name', 'sender_name', 'email_address', 'color', 'icon', 'protocol',
  'imap_host', 'imap_port', 'imap_tls', 'imap_skip_tls_verify',
  'smtp_host', 'smtp_port', 'smtp_tls',
  'auth_user', 'smtp_auth_user', 'oauth_provider', 'oauth_public_client', 'enabled',
  'include_in_unified_inbox', 'notifications_muted',
  'last_sync', 'sync_error', 'sync_error_code', 'sort_order', 'folder_mappings',
  'signature', 'signature_enabled', 'created_at', 'categorization_enabled',
  'auto_cc_addresses', 'auto_bcc_addresses',
];
// Columns PUT /:id may write. The settings form sends back what GET returned, so every
// non-secret one must be in SAFE_FIELDS or saving an unrelated edit would write it as empty.
export const ACCOUNT_UPDATE_FIELDS = ['name', 'sender_name', 'color', 'icon', 'enabled', 'include_in_unified_inbox', 'notifications_muted', 'auth_user', 'auth_pass', 'sort_order', 'imap_host', 'imap_port', 'imap_tls', 'imap_skip_tls_verify', 'smtp_host', 'smtp_port', 'smtp_tls', 'smtp_auth_user', 'smtp_auth_pass', 'folder_mappings', 'signature', 'signature_enabled', 'categorization_enabled', 'auto_cc_addresses', 'auto_bcc_addresses'];
// What an API token sees of an account (#617): enough to name it, pick a From and draft as the
// composer does (signature on or off, the automatic Cc and Bcc), and nothing of its settings:
// no hosts, ports, TLS or login names, signatures or folder mappings.
function tokenAccount(row, aliases) {
  return {
    id: row.id,
    name: row.name,
    sender_name: row.sender_name,
    email_address: row.email_address,
    color: row.color,
    icon: row.icon,
    enabled: row.enabled,
    include_in_unified_inbox: row.include_in_unified_inbox,
    last_sync: row.last_sync,
    sync_error: row.sync_error,
    signature_enabled: row.signature_enabled,
    auto_cc_addresses: row.auto_cc_addresses,
    auto_bcc_addresses: row.auto_bcc_addresses,
    aliases: aliases.map(({ id, name, email, reply_to }) => ({ id, name, email, reply_to })),
  };
}

function safeAccount(row) {
  const obj = Object.fromEntries(SAFE_FIELDS.map(k => [k, row[k]]));
  // Sanitize on read so legacy values stored before the write-time sanitizer are safe
  if (obj.signature) obj.signature = sanitizeSignature(obj.signature);
  return obj;
}

router.get('/', async (req, res) => {
  const result = await query(
    `SELECT ${SAFE_FIELDS.join(', ')}
     FROM email_accounts WHERE user_id = $1 ORDER BY sort_order, created_at`,
    [req.session.userId]
  );

  // Attach aliases to each account in one query
  const accountIds = result.rows.map(a => a.id);
  let aliasMap = {};
  if (accountIds.length) {
    const aliasResult = await query(
      `SELECT id, account_id, name, email, reply_to, signature, created_at
       FROM account_aliases WHERE account_id = ANY($1) ORDER BY created_at`,
      [accountIds]
    );
    for (const alias of aliasResult.rows) {
      if (!aliasMap[alias.account_id]) aliasMap[alias.account_id] = [];
      aliasMap[alias.account_id].push(alias);
    }
  }

  if (req.apiToken) return res.json(result.rows.map(a => tokenAccount(a, aliasMap[a.id] || [])));

  const enriched = result.rows.map((a) => ({
    ...a,
    signature: a.signature ? sanitizeSignature(a.signature) : a.signature,
    aliases: (aliasMap[a.id] || []).map(alias => ({
      ...alias,
      signature: alias.signature ? sanitizeSignature(alias.signature) : alias.signature,
    })),
  }));
  res.json(enriched);
});

router.post('/', async (req, res) => {
  const {
    name, sender_name = null, email_address, color = '#6366f1', icon = null, protocol = 'imap',
    imap_host, imap_port = 993, imap_skip_tls_verify = false,
    smtp_host, smtp_port = 587, smtp_tls = 'STARTTLS',
    auth_user, auth_pass, smtp_auth_user = null, smtp_auth_pass = null,
    signature = null, signature_enabled = true
  } = req.body;
  // OAuth fields (provider, tokens, client) are never taken from this body: Microsoft and
  // Google accounts are created only by the sign-in flows in routes/oauth.js, which check the
  // provider's identity token. A crafted request here makes a plain password account.

  if (!name || !email_address) return res.status(400).json({ error: 'Name and email required' });
  const { value: iconValue, error: iconError } = normalizeAccountIcon(icon);
  if (iconError) return res.status(400).json({ error: iconError });
  if (typeof signature_enabled !== 'boolean') return res.status(400).json({ error: 'signature_enabled must be a boolean' });
  if (hasHeaderInjectionChars(name) || hasHeaderInjectionChars(email_address)) {
    return res.status(400).json({ error: 'Name and email address cannot contain control characters' });
  }
  if (sender_name && hasHeaderInjectionChars(sender_name)) {
    return res.status(400).json({ error: 'Sender name cannot contain control characters' });
  }

  const policy = await getConnectionPolicy();

  if (imap_host) {
    const err = (await validateHost(imap_host, { allowPrivate: policy.allowPrivateHosts }))
      || (!policy.allowNonstandardPorts && validatePort(imap_port, ALLOWED_IMAP_PORTS));
    if (err) return res.status(400).json({ error: `IMAP: ${err}` });
  }
  if (smtp_host) {
    const err = (await validateHost(smtp_host, { allowPrivate: policy.allowPrivateHosts }))
      || (!policy.allowNonstandardPorts && validatePort(smtp_port, ALLOWED_SMTP_PORTS));
    if (err) return res.status(400).json({ error: `SMTP: ${err}` });
  }

  try {
    const result = await query(`
      INSERT INTO email_accounts (
        user_id, name, sender_name, email_address, color, protocol,
        imap_host, imap_port, imap_tls, imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
        auth_user, auth_pass, smtp_auth_user, smtp_auth_pass,
        signature, signature_enabled, icon, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,${NEXT_ACCOUNT_SORT_ORDER})
      RETURNING *
    `, [
      req.session.userId, name, sender_name || null, email_address, color, protocol,
      imap_host, imap_port, Number(imap_port) % 1000 === 993, !!imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
      auth_user, encrypt(auth_pass), smtp_auth_user || null, encrypt(smtp_auth_pass) || null,
      sanitizeSignature(signature) || null, signature_enabled !== false, iconValue
    ]);

    const account = result.rows[0];

    // Immediately try to connect — needs full credentials from DB row
    if (protocol === 'imap') {
      imapManager.connectAccount(account).catch(console.error);
    }

    res.json(safeAccount(account));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add account' });
  }
});

// The fields an OAuth sign-in owns: the server it was set up with and the passwords it does
// not use. The settings form does not show them for such an account, and they are ignored here
// too, so no request can point a Microsoft or Google sign-in at another server. auth_user stays
// editable: XOAUTH2 logs in as auth_user (or the address), which is how a shared or delegated
// Microsoft 365 mailbox is opened with one's own sign-in.
export const OAUTH_OWNED_FIELDS = [
  'imap_host', 'imap_port', 'imap_tls', 'imap_skip_tls_verify', 'smtp_host', 'smtp_port', 'smtp_tls',
  'auth_pass', 'smtp_auth_user', 'smtp_auth_pass',
];

// The sidebar order of all the user's accounts, first to last (#695).
router.patch('/order', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(isUuid)) {
    return res.status(400).json({ error: 'ids must list your accounts' });
  }
  try {
    if (!(await setAccountOrder(req.session.userId, ids))) {
      return res.status(409).json({ error: 'ids must list each of your accounts once' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /accounts/order error:', err.message);
    res.status(500).json({ error: 'Failed to reorder accounts' });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const updates = { ...req.body };

  // Verify ownership.
  const owned = await findOwnedAccount(req.session.userId, id, { columns: 'id, oauth_provider' });
  if (!owned) return res.status(404).json({ error: 'Account not found' });
  if (owned.oauth_provider) {
    for (const field of OAUTH_OWNED_FIELDS) delete updates[field];
    // An empty mailbox is not a login: ignored, the stored one stays.
    if ('auth_user' in updates && !String(updates.auth_user ?? '').trim()) delete updates.auth_user;
  }

  if ('name' in updates && hasHeaderInjectionChars(updates.name)) {
    return res.status(400).json({ error: 'Name cannot contain control characters' });
  }
  if ('sender_name' in updates && updates.sender_name && hasHeaderInjectionChars(updates.sender_name)) {
    return res.status(400).json({ error: 'Sender name cannot contain control characters' });
  }
  if ('signature_enabled' in updates && typeof updates.signature_enabled !== 'boolean') {
    return res.status(400).json({ error: 'signature_enabled must be a boolean' });
  }
  if ('icon' in updates) {
    const { value, error } = normalizeAccountIcon(updates.icon);
    if (error) return res.status(400).json({ error });
    updates.icon = value;
  }
  const policy = await getConnectionPolicy();

  if ('imap_host' in updates && updates.imap_host) {
    const err = await validateHost(updates.imap_host, { allowPrivate: policy.allowPrivateHosts });
    if (err) return res.status(400).json({ error: `IMAP: ${err}` });
  }
  if ('imap_port' in updates && updates.imap_port !== undefined && updates.imap_port !== null) {
    if (!policy.allowNonstandardPorts) {
      const err = validatePort(updates.imap_port, ALLOWED_IMAP_PORTS);
      if (err) return res.status(400).json({ error: `IMAP: ${err}` });
    }
  }
  if ('smtp_host' in updates && updates.smtp_host) {
    const err = await validateHost(updates.smtp_host, { allowPrivate: policy.allowPrivateHosts });
    if (err) return res.status(400).json({ error: `SMTP: ${err}` });
  }
  if ('smtp_port' in updates && updates.smtp_port !== undefined && updates.smtp_port !== null) {
    if (!policy.allowNonstandardPorts) {
      const err = validatePort(updates.smtp_port, ALLOWED_SMTP_PORTS);
      if (err) return res.status(400).json({ error: `SMTP: ${err}` });
    }
  }

  if ('imap_port' in updates) updates.imap_tls = Number(updates.imap_port) % 1000 === 993;

  try {
    if ('auto_cc_addresses' in updates) updates.auto_cc_addresses = normalizeAddressList(updates.auto_cc_addresses, 'Automatic Cc');
    if ('auto_bcc_addresses' in updates) updates.auto_bcc_addresses = normalizeAddressList(updates.auto_bcc_addresses, 'Automatic Bcc');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  // An address in both lists is refused, not guessed at: it was meant either to be seen (Cc) or hidden (Bcc).
  if ('auto_cc_addresses' in updates && 'auto_bcc_addresses' in updates) {
    const bcc = new Set(updates.auto_bcc_addresses.map(a => a.toLowerCase()));
    const shared = updates.auto_cc_addresses.find(a => bcc.has(a.toLowerCase()));
    if (shared) return res.status(400).json({ error: `${JSON.stringify(shared)} cannot be in both Automatic Cc and Automatic Bcc` });
  }

  const sets = [];
  const values = [];
  let i = 1;
  for (const key of ACCOUNT_UPDATE_FIELDS) {
    if (key in updates) {
      sets.push(`${key} = $${i++}`);
      const value = ((key === 'auth_pass' || key === 'smtp_auth_pass') && updates[key]) ? encrypt(updates[key])
        : (key === 'smtp_auth_user' || key === 'smtp_auth_pass') ? (updates[key] || null)
        : (key === 'signature') ? sanitizeSignature(updates[key]) || null
        : (key === 'include_in_unified_inbox' || key === 'notifications_muted') ? !!updates[key]
        : updates[key];
      values.push(value);
    }
  }

  if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(id);
  const result = await query(
    `UPDATE email_accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  const updated = result.rows[0];

  res.json(safeAccount(updated));

  // Sync live IMAP state after DB update (fire-and-forget, non-fatal). The reconnect triggers
  // are the connection/credential/host fields.
  const isDisabling = 'enabled' in updates && !updates.enabled;
  const needsReconnect = !isDisabling && (
    'enabled' in updates ||
    'auth_user' in updates ||
    'auth_pass' in updates ||
    'imap_host' in updates ||
    'imap_port' in updates ||
    'imap_tls' in updates ||
    'imap_skip_tls_verify' in updates
  );

  // Both branches queue through the per-account serializer so overlapping settings
  // changes (e.g. a rapid enabled double-toggle) apply their connection-state
  // effects in order, never as two overlapping chains.
  if (isDisabling) {
    reconnectQueue(id, () => imapManager.disconnectAccount(id))
      .catch(err => console.error(`Failed to disconnect account ${id} after disable:`, err.message));
  } else if (needsReconnect && updated.protocol === 'imap' && updated.enabled) {
    // An explicit settings change is how a wrong password gets fixed, so drop any backoff
    // first. Auth failures back off for hours, and without this the corrected credentials
    // would sit unused until that expired.
    imapManager.clearConnectCooldown(id);
    reconnectQueue(id, () =>
      imapManager.disconnectAccount(id)
        .then(() => query('SELECT * FROM email_accounts WHERE id = $1', [id]))
        .then(r => { if (r.rows.length) return imapManager.connectAccount(r.rows[0]); })
    ).catch(err => console.error(`Failed to reconnect account ${id} after update:`, err.message));
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await findOwnedAccount(req.session.userId, id, { columns: 'id' }))) return res.status(404).json({ error: 'Account not found' });

    // Delete from DB first (cascades to messages and folders immediately).
    // Disconnect IMAP afterward — fire-and-forget so a slow server logout
    // doesn't block the response.
    await query('DELETE FROM email_accounts WHERE id = $1', [id]);
    imapManager.disconnectAccount(id).catch(err =>
      console.error(`Disconnect error after delete for ${id}:`, err.message)
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Account delete error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

router.post('/:id/reconnect', async (req, res) => {
  const { id } = req.params;
  const account = await findOwnedAccount(req.session.userId, id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // An explicit Reconnect is a human saying "try now", so drop any backoff first. Auth
  // failures back off for up to six hours, and without this the button would answer
  // { ok: true } while connectAccount early-returned on the cooldown: a silent no-op.
  imapManager.clearConnectCooldown(id);
  // ?wait=1 answers with how the attempt went (bounded), for a "Try again" that has to say
  // whether it worked; without it the reconnect runs in the background as before. The old
  // error is forgotten first: connectAccount returns false at once when another connect is
  // already running, and that must read as "still connecting", not as the previous failure.
  if (req.query.wait) await imapManager.forgetAccountError?.(id, req.session.userId);
  const connecting = imapManager.connectAccount(account).catch((err) => { console.error(err); return false; });
  if (req.query.wait) {
    return res.json({ ok: true, ...(await reportConnect(connecting, id, { isConnected: () => !!imapManager.isConnected?.(id) })) });
  }
  res.json({ ok: true });
});

// ── Alias CRUD ─────────────────────────────────────────────────────────────

router.get('/:id/aliases', async (req, res) => {
  const { id } = req.params;
  if (!(await findOwnedAccount(req.session.userId, id, { columns: 'id' }))) return res.status(404).json({ error: 'Account not found' });

  const result = await query(
    'SELECT id, account_id, name, email, reply_to, signature, created_at FROM account_aliases WHERE account_id = $1 ORDER BY created_at',
    [id]
  );
  res.json(result.rows.map(alias => ({
    ...alias,
    signature: alias.signature ? sanitizeSignature(alias.signature) : alias.signature,
  })));
});

router.post('/:id/aliases', async (req, res) => {
  const { id } = req.params;
  const { name, email, reply_to, signature } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (hasHeaderInjectionChars(name) || hasHeaderInjectionChars(email) || hasHeaderInjectionChars(reply_to)) {
    return res.status(400).json({ error: 'Fields cannot contain control characters' });
  }

  if (!(await findOwnedAccount(req.session.userId, id, { columns: 'id' }))) return res.status(404).json({ error: 'Account not found' });

  const result = await query(
    'INSERT INTO account_aliases (account_id, name, email, reply_to, signature) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [id, name, email, reply_to || null, sanitizeSignature(signature) || null]
  );
  res.json(result.rows[0]);
});

router.put('/:id/aliases/:aliasId', async (req, res) => {
  const { id, aliasId } = req.params;
  const { name, email, reply_to, signature } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (hasHeaderInjectionChars(name) || hasHeaderInjectionChars(email) || hasHeaderInjectionChars(reply_to)) {
    return res.status(400).json({ error: 'Fields cannot contain control characters' });
  }

  const alias = await findOwnedAlias(req.session.userId, id, aliasId);
  if (!alias) return res.status(404).json({ error: 'Alias not found' });

  const result = await query(
    'UPDATE account_aliases SET name = $1, email = $2, reply_to = $3, signature = $4 WHERE id = $5 RETURNING *',
    [name, email, reply_to || null, sanitizeSignature(signature) || null, aliasId]
  );
  res.json(result.rows[0]);
});

router.delete('/:id/aliases/:aliasId', async (req, res) => {
  const { id, aliasId } = req.params;

  const alias = await findOwnedAlias(req.session.userId, id, aliasId);
  if (!alias) return res.status(404).json({ error: 'Alias not found' });

  await query('DELETE FROM account_aliases WHERE id = $1', [aliasId]);
  res.json({ ok: true });
});

router.get('/:id/folders', async (req, res) => {
  const { id } = req.params;
  if (!(await findOwnedAccount(req.session.userId, id, { columns: 'id' }))) return res.status(404).json({ error: 'Account not found' });

  const result = await query(
    'SELECT * FROM folders WHERE account_id = $1 ORDER BY path',
    [id]
  );
  // Freshness depends on how long this account's rotation takes, so every row needs the count.
  const selectableFolders = result.rows.filter(row => !row.no_select).length;
  res.json(result.rows.map(row => publicFolderCounts(row, Date.now(), { selectableFolders })));
});

router.post('/:id/reindex', async (req, res) => {
  try {
    const account = await findOwnedAccount(req.session.userId, req.params.id, { enabled: true, protocol: 'imap' });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const alreadyRunning = imapManager.backfillAllRunning.has(account.id);
    if (!alreadyRunning) {
      imapManager.backfillAllFolders(account).catch(err =>
        console.error(`Manual reindex error for ${account.email_address}:`, err.message)
      );
    }
    res.json({ ok: true, alreadyRunning });
  } catch (err) {
    console.error('POST /accounts/:id/reindex error:', err.message);
    res.status(500).json({ error: 'Failed to start reindex' });
  }
});

export default router;
