// The user's signature library (migration 0105): named signatures, each of which can be assigned
// to any of the user's accounts and aliases.
//
// email_accounts.signature and account_aliases.signature hold a copy of the assigned signature,
// and every send, draft and scheduled-send path reads that copy. This module is the only writer
// of those columns, and rewrites them in the same transaction as the change to the library, so
// the copy never differs from the entry it was assigned. An alias with no signature of its own
// (NULL) uses its account's, as it always has.
import { query, withTransaction } from './db.js';
import { sanitizeSignature } from './emailSanitizer.js';
import { isUuid } from '../utils/uuid.js';

export const MAX_SIGNATURE_NAME_LENGTH = 200;
export const MAX_SIGNATURES_PER_USER = 100;

export class SignatureLibraryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const COLUMNS = 'id, name, html, created_at, updated_at';

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new SignatureLibraryError(400, 'A signature needs a name');
  const trimmed = name.trim();
  if (trimmed.length > MAX_SIGNATURE_NAME_LENGTH) {
    throw new SignatureLibraryError(400, `A signature name may be at most ${MAX_SIGNATURE_NAME_LENGTH} characters`);
  }
  return trimmed;
}

function cleanHtml(html) {
  if (html == null) return '';
  if (typeof html !== 'string') throw new SignatureLibraryError(400, 'html must be a string');
  return sanitizeSignature(html) || '';
}

// What an account or alias column holds for a library entry: NULL for an empty one, as an
// account saved with an empty signature always had.
const copyOf = html => html || null;

const notFound = () => new SignatureLibraryError(404, 'Signature not found');

export async function listSignatures(userId, { queryFn = query } = {}) {
  const { rows } = await queryFn(
    `SELECT ${COLUMNS} FROM signatures WHERE user_id = $1 ORDER BY lower(name), created_at`, [userId]);
  // Sanitized again on read, as account signatures are, in case the sanitizer tightened since.
  return rows.map(r => ({ ...r, html: cleanHtml(r.html) }));
}

export async function createSignature(userId, { name, html } = {}, { transaction = withTransaction } = {}) {
  const cleanedName = cleanName(name);
  const cleanedHtml = cleanHtml(html);
  return transaction(async (client) => {
    // The count and the insert are one statement, so concurrent creates cannot both see room.
    const { rows } = await client.query(
      `INSERT INTO signatures (user_id, name, html)
       SELECT $1, $2, $3 WHERE (SELECT COUNT(*) FROM signatures WHERE user_id = $1) < $4
       RETURNING ${COLUMNS}`,
      [userId, cleanedName, cleanedHtml, MAX_SIGNATURES_PER_USER]);
    if (!rows.length) throw new SignatureLibraryError(409, `You can keep at most ${MAX_SIGNATURES_PER_USER} signatures`);
    return rows[0];
  });
}

// Renames and/or edits an entry; an edit reaches every account and alias it is assigned to.
export async function updateSignature(userId, id, { name, html } = {}, { transaction = withTransaction } = {}) {
  if (!isUuid(id)) throw notFound();
  const sets = [];
  const values = [id, userId];
  if (name !== undefined) { values.push(cleanName(name)); sets.push(`name = $${values.length}`); }
  if (html !== undefined) { values.push(cleanHtml(html)); sets.push(`html = $${values.length}`); }
  if (!sets.length) throw new SignatureLibraryError(400, 'Nothing to update');
  return transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE signatures SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`, values);
    if (!rows.length) throw notFound();
    if (html !== undefined) await rewriteCopies(client, userId, id, copyOf(rows[0].html));
    return rows[0];
  });
}

// Deletes an entry. The accounts and aliases it was assigned to are left with no signature, as if
// "No signature" had been assigned, rather than keeping a copy nothing in the library names.
export async function deleteSignature(userId, id, { transaction = withTransaction } = {}) {
  if (!isUuid(id)) throw notFound();
  return transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id FROM signatures WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
    if (!rows.length) throw notFound();
    await rewriteCopies(client, userId, id, null, { unassign: true });
    await client.query('DELETE FROM signatures WHERE id = $1 AND user_id = $2', [id, userId]);
  });
}

async function rewriteCopies(client, userId, signatureId, copy, { unassign = false } = {}) {
  const assignment = unassign ? ', signature_id = NULL' : '';
  await client.query(
    `UPDATE email_accounts SET signature = $1${assignment} WHERE signature_id = $2 AND user_id = $3`,
    [copy, signatureId, userId]);
  await client.query(
    `UPDATE account_aliases al SET signature = $1${assignment}
       FROM email_accounts a
      WHERE al.account_id = a.id AND al.signature_id = $2 AND a.user_id = $3`,
    [copy, signatureId, userId]);
}

// Assigns a library entry (or none, signatureId null) to one of the user's accounts, or to one
// of its aliases when aliasId is given. For an alias, none means "use the account's".
export async function assignSignature(userId, { accountId, aliasId = null, signatureId = null } = {}, { transaction = withTransaction } = {}) {
  if (!isUuid(accountId)) throw new SignatureLibraryError(404, 'Account not found');
  if (aliasId !== null && !isUuid(aliasId)) throw new SignatureLibraryError(404, 'Alias not found');
  if (signatureId !== null && !isUuid(signatureId)) throw notFound();
  return transaction(async (client) => {
    let copy = null;
    if (signatureId) {
      // FOR SHARE: an edit of this entry waits for the assignment, then rewrites its copy too.
      const { rows } = await client.query(
        'SELECT html FROM signatures WHERE id = $1 AND user_id = $2 FOR SHARE', [signatureId, userId]);
      if (!rows.length) throw notFound();
      copy = copyOf(cleanHtml(rows[0].html));
    }
    if (aliasId) {
      const { rowCount } = await client.query(
        `UPDATE account_aliases al SET signature_id = $1, signature = $2
           FROM email_accounts a
          WHERE al.id = $3 AND al.account_id = $4 AND a.id = al.account_id AND a.user_id = $5`,
        [signatureId, copy, aliasId, accountId, userId]);
      if (!rowCount) throw new SignatureLibraryError(404, 'Alias not found');
    } else {
      const { rowCount } = await client.query(
        'UPDATE email_accounts SET signature_id = $1, signature = $2 WHERE id = $3 AND user_id = $4',
        [signatureId, copy, accountId, userId]);
      if (!rowCount) throw new SignatureLibraryError(404, 'Account not found');
    }
    return { accountId, aliasId, signatureId, signature: copy };
  });
}

// An account or alias created with a signature in its body (an API client, or a browser still
// running the old account form) gets it as a library entry, as migration 0105 did for existing ones.
export async function adoptSignature(userId, { accountId, aliasId = null, name, html }, { transaction = withTransaction } = {}) {
  if (!html || !String(html).trim()) return null;
  const entry = await createSignature(userId, { name, html }, { transaction });
  await assignSignature(userId, { accountId, aliasId, signatureId: entry.id }, { transaction });
  return entry;
}

// The library entry name migration 0105 gives an account's or alias's own signature.
export function signatureNameFor(name, email) {
  const n = typeof name === 'string' ? name.trim() : '';
  return !n || n.toLowerCase() === String(email || '').toLowerCase() ? String(email || '') : `${n} (${email})`;
}
