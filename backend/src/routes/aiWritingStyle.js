import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../services/db.js';
import { completeText } from '../services/aiProvider.js';
import { consume } from '../services/rateLimiter.js';
import {
  STYLE_MAX_MESSAGES,
  STYLE_MIN_SAMPLES,
  STYLE_PROFILE_MAX_CHARS,
  learnStylePrompt,
  normalizeProfile,
  sampleText,
  selectSamples,
} from '../services/writingStyle.js';
import { gateAiRequest, serviceError } from './ai.js';

const router = Router();

// Learning reads up to 25 sent messages and makes one provider call, so it is kept rare.
const LEARN_LIMIT = { max: 3, windowMs: 10 * 60 * 1000 };
// Sent messages whose body was never opened are fetched from IMAP, a few and one at a time, so
// learning cannot crowd the account's connections. The bodies are only read, never stored.
const MAX_IMAP_FETCHES = 12;
const IMAP_FETCH_TIMEOUT_MS = 8000;

function present(row) {
  return {
    enabled: row?.ai_writing_style_enabled === true,
    profile: row?.ai_writing_style ?? null,
    samples: row?.ai_writing_style_samples ?? null,
    updatedAt: row?.ai_writing_style_updated_at ?? null,
  };
}

const STYLE_COLUMNS = 'ai_writing_style, ai_writing_style_enabled, ai_writing_style_samples, ai_writing_style_updated_at';

async function loadStyle(userId) {
  const { rows: [row] } = await query(`SELECT ${STYLE_COLUMNS} FROM users WHERE id = $1`, [userId]);
  return row;
}

router.get('/ai/writing-style', requireAuth, async (req, res) => {
  try {
    res.json(present(await loadStyle(req.session.userId)));
  } catch (error) {
    serviceError(res, error, 'Failed to load writing style');
  }
});

router.put('/ai/writing-style', requireAuth, async (req, res) => {
  const body = req.body || {};
  const hasEnabled = Object.hasOwn(body, 'enabled');
  const hasProfile = Object.hasOwn(body, 'profile');
  if (!hasEnabled && !hasProfile) return res.status(400).json({ error: 'enabled or profile is required' });
  if (hasEnabled && typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  if (hasProfile && body.profile !== null && typeof body.profile !== 'string') {
    return res.status(400).json({ error: 'profile must be a string or null' });
  }
  if (hasProfile && typeof body.profile === 'string' && body.profile.trim().length > STYLE_PROFILE_MAX_CHARS) {
    return res.status(400).json({ error: `profile must be at most ${STYLE_PROFILE_MAX_CHARS} characters` });
  }

  const userId = req.session.userId;
  try {
    if (hasProfile && normalizeProfile(body.profile) === null) {
      // Clearing the profile also turns the style off: there is nothing left to follow.
      const { rows: [row] } = await query(
        `UPDATE users SET ai_writing_style = NULL, ai_writing_style_enabled = FALSE,
           ai_writing_style_samples = NULL, ai_writing_style_updated_at = NULL
         WHERE id = $1 RETURNING ${STYLE_COLUMNS}`, [userId]);
      return res.json(present(row));
    }
    const current = await loadStyle(userId);
    const profile = hasProfile ? normalizeProfile(body.profile) : current?.ai_writing_style ?? null;
    const enabled = hasEnabled ? body.enabled : current?.ai_writing_style_enabled === true;
    if (enabled && !profile) {
      return res.status(400).json({ error: 'There is no writing style to use yet', code: 'no_profile' });
    }
    const { rows: [row] } = await query(
      `UPDATE users SET ai_writing_style = $2, ai_writing_style_enabled = $3,
         ai_writing_style_updated_at = CASE WHEN $4::boolean THEN NOW() ELSE ai_writing_style_updated_at END
       WHERE id = $1 RETURNING ${STYLE_COLUMNS}`,
      [userId, profile, enabled, hasProfile]);
    res.json(present(row));
  } catch (error) {
    serviceError(res, error, 'Failed to save writing style');
  }
});

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The user's own words from their most recent sent mail, in the Sent folder of each enabled
// account: the folder the account maps as Sent, or the one the server marks \Sent.
export async function collectSentSamples(userId, imapManager) {
  const { rows: accounts } = await query(
    'SELECT * FROM email_accounts WHERE user_id = $1 AND enabled = true', [userId]);
  if (!accounts.length) return [];
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const { rows } = await query(
    `SELECT m.account_id, m.uid, m.folder, m.body_text, m.body_html, m.snippet
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND a.enabled = true AND m.is_deleted = false
        AND (m.folder = a.folder_mappings->>'sent'
             OR m.folder IN (SELECT f.path FROM folders f WHERE f.account_id = a.id AND f.special_use = '\\Sent'))
      ORDER BY m.date DESC NULLS LAST
      LIMIT $2`,
    [userId, STYLE_MAX_MESSAGES]);

  const texts = [];
  let fetches = 0;
  for (const row of rows) {
    let bodyText = row.body_text;
    let bodyHtml = row.body_html;
    const account = byId.get(row.account_id);
    if (!bodyText?.trim() && !bodyHtml?.trim() && imapManager && account && fetches < MAX_IMAP_FETCHES) {
      fetches++;
      try {
        const body = await withTimeout(
          imapManager.fetchMessageBody(account, row.uid, row.folder, { background: true }),
          IMAP_FETCH_TIMEOUT_MS);
        bodyText = body?.text ?? null;
        bodyHtml = body?.html ?? null;
      } catch { /* best effort: the snippet stands in for a body that could not be fetched */ }
    }
    texts.push(sampleText({ bodyText, bodyHtml, snippet: row.snippet }));
  }
  return selectSamples(texts);
}

router.post('/ai/writing-style/learn', requireAuth, async (req, res) => {
  if (!(await gateAiRequest(req, res, 'compose'))) return;
  const userId = req.session.userId;
  const rate = await consume(`ai_writing_style_learn:${userId}`, LEARN_LIMIT.max, LEARN_LIMIT.windowMs);
  if (rate.limited) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.', code: 'rate_limited' });
  }

  let samples;
  try {
    samples = await collectSentSamples(userId, req.app.get('imapManager'));
  } catch (error) {
    return serviceError(res, error, 'Failed to read sent mail');
  }
  if (samples.length < STYLE_MIN_SAMPLES) {
    return res.status(422).json({
      error: `At least ${STYLE_MIN_SAMPLES} sent emails are needed to learn your style.`,
      code: 'not_enough_mail',
    });
  }

  let profile;
  try {
    profile = normalizeProfile(await completeText(learnStylePrompt(samples), { maxTokens: 800 }));
  } catch (error) {
    return serviceError(res, error, 'AI request failed');
  }
  if (!profile) return res.status(502).json({ error: 'The AI returned no writing style. Try again.' });

  try {
    const { rows: [row] } = await query(
      `UPDATE users SET ai_writing_style = $2, ai_writing_style_enabled = TRUE,
         ai_writing_style_samples = $3, ai_writing_style_updated_at = NOW()
       WHERE id = $1 RETURNING ${STYLE_COLUMNS}`,
      [userId, profile, samples.length]);
    res.json(present(row));
  } catch (error) {
    serviceError(res, error, 'Failed to save writing style');
  }
});

export default router;
