// The demo's backend: answers the app's /api requests in the browser, from the fictional mailbox
// in data.js, keeping every change in memory until the page reloads. The shapes follow the real
// routes in backend/src/routes/.

import {
  USER, ACCOUNTS, STANDARD_FOLDERS, EXTRA_FOLDERS, ATTACHMENT_FILES, CONTACTS, CONTACT_GROUPS,
  CALENDAR_ACCOUNTS, CALENDARS, buildMessages, buildEvents, moodboardSvg,
} from './data.js';
import { PGP } from './pgpFixtures.js';

const started = Date.now();
const iso = ms => new Date(ms).toISOString();
let seq = 9000;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const db = {
  prefs: {
    theme: undefined,
    conversationMode: 'list',
    threadedView: true,
    favoriteFolders: [],
    blockRemoteImages: true,
  },
  accounts: ACCOUNTS.map((a, i) => ({
    id: a.id, name: a.name, sender_name: 'Maya Lindqvist', email_address: a.email, color: a.color, icon: null,
    protocol: 'imap', imap_host: a.host, imap_port: 993, imap_tls: true, imap_skip_tls_verify: false,
    smtp_host: a.host.replace(/^(imap|mail|mx)\./, 'smtp.'), smtp_port: 587, smtp_tls: 'STARTTLS',
    auth_user: a.email, smtp_auth_user: null, oauth_provider: null, oauth_public_client: false, enabled: true,
    include_in_unified_inbox: true, notifications_muted: false, last_sync: iso(started - 40_000),
    sync_error: null, sync_error_code: null, sort_order: i,
    folder_mappings: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', spam: 'Junk', archive: 'Archive' },
    signature: i === 0 ? '<p>Maya Lindqvist<br>Design lead, Brightwater Studio</p>' : null,
    signature_enabled: i === 0, created_at: '2026-01-12T10:00:00.000Z', categorization_enabled: true,
    auto_cc_addresses: [], auto_bcc_addresses: [], aliases: [], connected: true,
  })),
  folders: {},
  messages: buildMessages(started),
  contacts: CONTACTS.map(c => ({ ...c })),
  groups: CONTACT_GROUPS.map(g => ({ ...g, members: g.members.map(i => CONTACTS[i].id), created_at: iso(started - 9e9), updated_at: iso(started - 9e9) })),
  calendars: CALENDARS.map(c => ({ ...c })),
  events: buildEvents(new Date(started)),
  passkeys: [
    { id: 'demo-passkey-1', name: 'MacBook Touch ID', createdAt: '2026-05-04T08:12:00.000Z', lastUsedAt: iso(started - 2 * 3600e3), backedUp: true },
    { id: 'demo-passkey-2', name: 'YubiKey 5C', createdAt: '2026-06-19T17:40:00.000Z', lastUsedAt: '2026-10-30T09:02:00.000Z', backedUp: false },
  ],
  sieve: Object.fromEntries(ACCOUNTS.map((a, i) => [a.id, {
    rules: i === 0 ? [
      { field: 'from', contains: 'billing@cloudberry.example.net', action: 'move', folder: 'Receipts' },
      { field: 'subject', contains: 'Harbor & Pine', action: 'move', folder: 'Clients/Harbor & Pine' },
      { field: 'from', contains: 'lucky-draw.example.com', action: 'delete' },
    ] : i === 2 ? [{ field: 'from', contains: 'kilnworks.example.net', action: 'move', folder: 'Suppliers' }] : [],
    vacation: i === 0 ? {
      enabled: true, subject: 'Away until Monday', days: 7, addresses: [],
      body: 'Hi,\n\nI am away for a long weekend and back on Monday. I will answer then.\n\nMaya',
      start: null, end: null,
    } : null,
  }])),
  rules: [],
  apiTokens: [
    { id: 'demo-token-1', name: 'Home automation', scopes: ['mail:read'], createdAt: '2026-08-01T12:00:00.000Z', lastUsedAt: iso(started - 86400e3), expiresAt: null, prefix: 'plm_7Qx' },
  ],
  keyring: [{ email: 'elena@quillpress.example.org', fingerprint: PGP.elena.fingerprint, armored: PGP.elenaPublic, source: 'manual', verified: true, last_seen: iso(started - 30 * 86400e3) }],
};

for (const a of ACCOUNTS) {
  db.folders[a.id] = [
    ...STANDARD_FOLDERS.map(([path, name, special]) => ({ path, name, special })),
    ...(EXTRA_FOLDERS[a.id] || []).map(([path, name]) => ({ path, name, special: null })),
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok = (extra = {}) => ({ ok: true, ...extra });
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const notFound = () => { throw new HttpError(404, 'Not found'); };

const accountById = id => db.accounts.find(a => a.id === id);
const messageById = id => db.messages.find(m => m.id === id) || notFound();
const live = () => db.messages.filter(m => !m.deleted);

function rowOf(m) {
  const a = accountById(m.account_id);
  const row = { ...m };
  delete row.body;
  delete row.deleted;
  return { ...row, account_name: a.name, account_email: a.email_address, account_color: a.color };
}

function folderRow(accountId, f) {
  const inFolder = live().filter(m => m.account_id === accountId && m.folder === f.path);
  const unread = inFolder.filter(m => !m.is_read).length;
  return {
    id: `${accountId}:${f.path}`, account_id: accountId, path: f.path, name: f.name, delimiter: '/',
    special_use: f.special, no_select: false, uid_validity: 1, updated_at: iso(started),
    total_count: inFolder.length, unread_count: unread, cached_total_count: inFolder.length, cached_unread_count: unread,
    server_total_count: inFolder.length, server_unread_count: unread, server_counts_at: iso(Date.now()),
    counts_known: true, counts_stale: false,
  };
}

function unreadCounts() {
  const byAccount = {}, snapshots = {};
  let total = 0;
  for (const a of db.accounts) {
    const inbox = live().filter(m => m.account_id === a.id && m.folder === 'INBOX');
    const n = inbox.filter(m => !m.is_read).length;
    byAccount[a.id] = n;
    snapshots[a.id] = { totalCount: inbox.length, revision: String(Date.now()), attemptRevision: String(Date.now()), observedAt: iso(Date.now()), stale: false, known: true };
    if (a.include_in_unified_inbox !== false) total += n;
  }
  return { total, byAccount, snapshots, complete: true, snoozed: 0, scheduled: { pending: 0, attention: 0 } };
}

const byDateDesc = (a, b) => new Date(b.date) - new Date(a.date);

function sortRows(rows, { sort, dir, starredFirst }) {
  const d = dir === 'asc' ? 1 : -1;
  const key = sort === 'from' ? r => (r.from_name || r.from_email || '').toLowerCase()
    : sort === 'subject' ? r => (r.subject || '').replace(/^(re|fwd?):\s*/i, '').toLowerCase() : null;
  return rows.sort((a, b) => {
    if (starredFirst === 'true' && a.is_starred !== b.is_starred) return a.is_starred ? -1 : 1;
    if (key) { const c = key(a).localeCompare(key(b)) * d; if (c) return c; }
    return (new Date(a.date) - new Date(b.date)) * (key ? -1 : d);
  });
}

function listMessages(q) {
  const folder = q.folder || 'INBOX';
  const scope = q.accountId ? [q.accountId] : db.accounts.filter(a => a.include_in_unified_inbox !== false).map(a => a.id);
  let rows = live().filter(m => scope.includes(m.account_id) && m.folder === (q.accountId ? folder : 'INBOX'));
  if (q.unreadOnly === 'true') rows = rows.filter(m => !m.is_read);
  if (q.category && q.category !== 'primary') rows = rows.filter(m => m.category === q.category);
  if (q.category === 'primary') rows = rows.filter(m => !m.category || m.category === 'primary');
  const limit = Number(q.limit) || 50, offset = Number(q.offset) || 0;

  if (q.threaded === 'true') {
    const groups = new Map();
    for (const m of rows) groups.set(m.thread_id, [...(groups.get(m.thread_id) || []), m]);
    const threads = [...groups.values()].map((list) => {
      list.sort((a, b) => new Date(a.date) - new Date(b.date));
      const opener = list[0];
      const rep = [...list].sort(byDateDesc)[0];
      const whole = live().filter(m => m.account_id === rep.account_id && m.thread_id === rep.thread_id && !m.is_draft);
      return {
        ...rowOf(rep), subject: opener.subject, from_name: opener.from_name, from_email: opener.from_email,
        reply_from_name: rep.from_name, reply_from_email: rep.from_email, reply_subject: rep.subject,
        message_count: Math.max(1, whole.length), unread_count: list.filter(m => !m.is_read).length,
        others_starred: list.some(m => m !== rep && m.is_starred),
        is_starred: rep.is_starred || list.some(m => m.is_starred),
      };
    });
    sortRows(threads, q);
    return { messages: threads.slice(offset, offset + limit), total: threads.length, threaded: true };
  }
  const sorted = sortRows(rows.map(rowOf), q);
  return { messages: sorted.slice(offset, offset + limit), total: sorted.length };
}

function threadOf(threadId) {
  return { messages: live().filter(m => m.thread_id === threadId).sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(m => ({ ...rowOf(m), in_trash: m.folder === 'Trash' })) };
}

function moveTo(m, folder) {
  if (m.folder === folder) return;
  const used = live().filter(x => x.account_id === m.account_id && x.folder === folder).map(x => x.uid);
  m.folder = folder;
  m.uid = Math.max(100, ...used) + 1;
}

function trash(m) {
  if (m.folder === 'Trash' || m.is_draft) m.deleted = true;
  else moveTo(m, 'Trash');
}

function bodyOf(m) {
  const { html, text, attachments, pgp } = m.body;
  return {
    html, darkCss: null, lightOnly: false, inlineImagesFitted: false, text,
    attachments: attachments.map(a => ({ part: a.part, filename: a.filename, type: a.type, size: a.size, disposition: a.disposition })), pgp,
    hasBlockedRemoteImages: false, remoteImagesBlocked: false, remoteImagesProxied: false, trackersBlocked: 0,
    senderEmail: null, senderName: null, forwardedFromEmail: null, forwardedFromName: null, forwardedVia: null,
    bccAddresses: [],
  };
}

const fmtAddr = list => list.map(a => (a.name ? `"${a.name}" <${a.email}>` : a.email)).join(', ');

function rawEml(m) {
  const head = [
    `From: ${fmtAddr([{ name: m.from_name, email: m.from_email }])}`,
    `To: ${fmtAddr(m.to_addresses)}`,
    ...(m.cc_addresses.length ? [`Cc: ${fmtAddr(m.cc_addresses)}`] : []),
    `Subject: ${m.subject}`,
    `Date: ${new Date(m.date).toUTCString()}`,
    `Message-ID: ${m.message_id}`,
    'MIME-Version: 1.0',
    'X-Plimail-Demo: this message is fictional',
  ];
  const { html, text } = m.body;
  if (text && (m.body.pgp || !html)) return [...head, 'Content-Type: text/plain; charset=utf-8', '', text].join('\r\n');
  return [...head, 'Content-Type: text/html; charset=utf-8', '', html || ''].join('\r\n');
}

function headersOf(m) {
  const raw = rawEml(m);
  const headerText = raw.split('\r\n\r\n')[0];
  return { headers: headerText, raw: headerText };
}

function inviteIcs() {
  const ev = db.events.find(e => e.summary === 'Design critique');
  const stamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Plimail demo//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:${ev?.uid || 'demo'}`, `DTSTART:${stamp(ev?.start || started)}`, `DTEND:${stamp(ev?.end || started)}`,
    'SUMMARY:Design critique', 'LOCATION:Studio (2nd floor)',
    'ORGANIZER;CN=Léa Moreau:mailto:lea@brightwater.example.com',
    'ATTENDEE;CN=Maya Lindqvist;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:maya@brightwater.example.com',
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

async function svgToPng(svg) {
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  URL.revokeObjectURL(img.src);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function attachmentOf(m, part) {
  const a = m.body.attachments.find(x => x.part === part) || notFound();
  if (a.file === 'moodboard') return svgToPng(moodboardSvg);
  if (a.file === 'invite') return new Blob([inviteIcs()], { type: 'text/calendar' });
  const file = ATTACHMENT_FILES[a.file] || notFound();
  return new Blob([file.data], { type: file.type });
}

function search(q) {
  const term = String(q.q || '').toLowerCase().replace(/\b(from|to|subject|in|is):\S*/g, '').trim();
  const words = term.split(/\s+/).filter(Boolean);
  const rows = live().filter((m) => {
    if (q.accountId && m.account_id !== q.accountId) return false;
    if (q.folder && q.allFolders !== 'true' && q.folder !== 'INBOX' && m.folder !== q.folder) return false;
    const hay = `${m.subject} ${m.from_name} ${m.from_email} ${m.snippet} ${m.body.text || ''}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
  return { messages: rows.sort(byDateDesc).slice(0, 50).map(rowOf), query: q.q };
}

function suggestContacts(q) {
  const term = String(q.q || '').toLowerCase();
  return {
    contacts: db.contacts.filter(c => `${c.display_name} ${c.primary_email}`.toLowerCase().includes(term))
      .slice(0, 8).map(c => ({ email: c.primary_email, name: c.display_name, send_count: c.send_count, last_sent: c.last_sent })),
  };
}

function listContacts(q) {
  const term = String(q.q || q.search || '').toLowerCase();
  let rows = db.contacts;
  if (term) rows = rows.filter(c => `${c.display_name} ${c.primary_email} ${c.organization || ''}`.toLowerCase().includes(term));
  if (q.groupId) {
    const g = db.groups.find(x => x.id === q.groupId);
    rows = rows.filter(c => g?.members.includes(c.id));
  }
  rows = [...rows].sort((a, b) => b.send_count - a.send_count || a.display_name.localeCompare(b.display_name));
  return { contacts: rows, total: rows.length };
}

const groupView = g => ({ id: g.id, name: g.name, source: g.source, created_at: g.created_at, updated_at: g.updated_at, member_count: g.members.length });

function eventsBetween(q) {
  const from = Date.parse(q.from), to = Date.parse(q.to);
  const visible = new Set(db.calendars.filter(c => c.visible && !c.ignored).map(c => c.id));
  return {
    events: db.events.filter((e) => {
      if (!visible.has(e.calendarId)) return false;
      const s = Date.parse(e.start), en = Date.parse(e.end);
      return s < to && en > from;
    }),
  };
}

function sieveState(accountId) {
  const s = db.sieve[accountId] || notFound();
  return {
    supported: true, implementation: 'Dovecot Pigeonhole', extensions: ['fileinto', 'vacation', 'date', 'relational', 'imap4flags', 'redirect'],
    scripts: [{ name: 'plimail', active: true }], active: 'plimail', otherActive: null,
    plimail: { exists: true, managed: true, rules: s.rules, vacation: s.vacation, content: '# plimail-meta: (demo)\nrequire ["fileinto", "vacation"];\n' },
  };
}

function ownKeys() {
  return {
    keys: [{
      id: 'demo-pgp-key-1', accountId: ACCOUNTS[1].id, fingerprint: PGP.maya.fingerprint,
      emails: ['maya.lindqvist@example.org'], userIds: ['Maya Lindqvist <maya.lindqvist@example.org>'],
      algorithm: PGP.maya.algorithm, keyCreatedAt: PGP.maya.created, createdAt: PGP.maya.created,
      armoredPublic: PGP.mayaPublic, armoredPrivate: PGP.mayaPrivate, protection: 'passphrase', auto: false, stale: false,
    }],
  };
}

function pgpLookup(body) {
  const results = {};
  for (const raw of body?.emails || []) {
    const email = String(raw).trim().toLowerCase();
    if (email === 'maya.lindqvist@example.org') results[email] = { source: 'own', keys: [{ fingerprint: PGP.maya.fingerprint, armored: PGP.mayaPublic, source: 'own', verified: true }] };
    else {
      const k = db.keyring.find(r => r.email === email);
      results[email] = k ? { source: 'keyring', keys: [{ fingerprint: k.fingerprint, armored: k.armored, source: k.source, verified: k.verified }] } : { source: null, keys: [] };
    }
  }
  return { results };
}

// A sent message goes straight to the account's Sent folder; nothing leaves the browser.
function send(body) {
  const account = accountById(body.accountId) || db.accounts[0];
  const list = v => (Array.isArray(v) ? v : String(v || '').split(','))
    .map(x => (typeof x === 'string' ? { name: '', email: x.trim() } : { name: x.name || '', email: x.email || x.address || '' }))
    .filter(x => x.email);
  const replyTo = body.inReplyTo ? live().find(m => m.message_id === body.inReplyTo) : null;
  const html = body.html || (body.text ? `<p>${String(body.text).replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>` : '');
  const m = {
    id: newId(), uid: 0, account_id: account.id, folder: 'INBOX', message_id: `<demo-sent-${seq}@plimail.example.com>`,
    thread_id: replyTo?.thread_id || `<demo-sent-${seq}@plimail.example.com>`, subject: body.subject || '(no subject)',
    from_name: account.sender_name, from_email: account.email_address, to_addresses: list(body.to), cc_addresses: list(body.cc),
    reply_to: [], in_reply_to: body.inReplyTo || null, thread_references: [], date: iso(Date.now()),
    snippet: String(body.text || html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 180),
    is_read: true, is_starred: false, is_draft: false, has_attachments: false, category: null,
    list_unsubscribe: null, list_unsubscribe_post: null, unsubscribed_at: null, delivery_addresses: [], has_contact_photo: false,
    body: { html, text: body.text || null, attachments: [], pgp: null },
  };
  db.messages.push(m);
  moveTo(m, 'Sent');
  if (replyTo) replyTo.flags = 'answered';
  window.dispatchEvent(new CustomEvent('plimail-demo:sent', { detail: { subject: m.subject } }));
  return { ok: true, messageId: m.id, sentFolder: 'Sent', sentCopySaved: true, accepted: m.to_addresses.map(a => a.email), rejected: [] };
}

// A reaction (backend/src/routes/send.js) lands in Sent as a reply carrying its emoji.
function sendReaction({ messageId, emoji }) {
  const target = messageById(messageId);
  const account = accountById(target.account_id) || db.accounts[0];
  const others = [target.from_email ? { name: target.from_name, email: target.from_email } : null, ...(target.to_addresses || []), ...(target.cc_addresses || [])]
    .filter(a => a?.email && a.email !== account.email_address);
  const m = {
    id: newId(), uid: 0, account_id: account.id, folder: 'INBOX', message_id: `<demo-sent-${seq}@plimail.example.com>`,
    thread_id: target.thread_id, subject: /^re:/i.test(target.subject || '') ? target.subject : `Re: ${target.subject || ''}`,
    from_name: account.sender_name, from_email: account.email_address, to_addresses: others.slice(0, 1), cc_addresses: others.slice(1),
    reply_to: [], in_reply_to: target.message_id, thread_references: [], date: iso(Date.now()), snippet: emoji,
    reaction_emoji: emoji, is_read: true, is_starred: false, is_draft: false, has_attachments: false, category: null,
    list_unsubscribe: null, list_unsubscribe_post: null, unsubscribed_at: null, delivery_addresses: [], has_contact_photo: false,
    body: { html: `<div style="font-size:32px">${emoji}</div>`, text: emoji, attachments: [], pgp: null },
  };
  db.messages.push(m);
  moveTo(m, 'Sent');
  return { ok: true, emoji, sentFolder: 'Sent' };
}

function saveDraft(body) {
  const account = accountById(body.accountId) || db.accounts[0];
  let m = body.uid ? live().find(x => x.account_id === account.id && x.folder === 'Drafts' && x.uid === body.uid) : null;
  if (!m) {
    m = { id: newId(), uid: 0, account_id: account.id, folder: 'INBOX', message_id: `<demo-draft-${seq}@plimail.example.com>`, thread_id: `<demo-draft-${seq}@plimail.example.com>`,
      reply_to: [], in_reply_to: null, thread_references: [], is_read: true, is_starred: false, is_draft: true, has_attachments: false, category: null,
      list_unsubscribe: null, list_unsubscribe_post: null, unsubscribed_at: null, delivery_addresses: [], has_contact_photo: false, cc_addresses: [] };
    db.messages.push(m);
    moveTo(m, 'Drafts');
  }
  Object.assign(m, {
    subject: body.subject || '(no subject)', from_name: account.sender_name, from_email: account.email_address,
    to_addresses: (Array.isArray(body.to) ? body.to : String(body.to || '').split(',')).map(x => (typeof x === 'string' ? { name: '', email: x.trim() } : x)).filter(x => x.email),
    date: iso(Date.now()), snippet: String(body.text || '').slice(0, 180),
    body: { html: body.html || null, text: body.text || null, attachments: [], pgp: null },
  });
  return { ok: true, uid: m.uid, folder: 'Drafts', accountId: account.id, messageId: m.id };
}

// ── Routes ────────────────────────────────────────────────────────────────────

const routes = [];
const on = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler });
};

// Auth and the signed-in user
on('GET', '/auth/me', () => ({ user: { id: USER.id, username: USER.username, displayName: USER.displayName, avatar: null, isAdmin: false, totpEnabled: true, hasPassword: true, hasLockPin: false, locked: false } }));
on('POST', '/auth/login', () => ({ user: { id: USER.id, username: USER.username, displayName: USER.displayName, avatar: null, isAdmin: false, totpEnabled: true, hasPassword: true, hasLockPin: false, locked: false } }));
on('POST', '/auth/logout', () => ok());
on('GET', '/auth/preferences', () => ({ ...db.prefs }));
on('PATCH', '/auth/preferences', ({ body }) => { Object.assign(db.prefs, body || {}); return ok(); });
on('POST', '/auth/preferences/whitelist-add', () => ok());
on('PATCH', '/auth/profile', ({ body }) => { if (body?.displayName) USER.displayName = body.displayName; return ok({ user: USER }); });
on('GET', '/auth/profile/recovery-email', () => ({ email: 'maya.lindqvist@example.org', verified: true }));
on('GET', '/auth/registration-status', () => ({ open: false, inviteOnly: true }));
on('GET', '/auth/oidc/providers', () => []);
on('GET', '/auth/oidc/identities', () => ({ identities: [] }));
on('GET', '/auth/push/vapid-key', () => { throw new HttpError(404, 'Push is not available in the demo'); });
on('GET', '/passkeys/status', () => ({ available: true, rpId: location.hostname }));
on('GET', '/passkeys', () => ({ passkeys: db.passkeys }));
on('PATCH', '/passkeys/:id', ({ params, body }) => { const p = db.passkeys.find(x => x.id === params.id) || notFound(); p.name = body?.name || p.name; return { passkey: p }; });
on('DELETE', '/passkeys/:id', ({ params }) => { db.passkeys = db.passkeys.filter(x => x.id !== params.id); return ok(); });
on('GET', '/api-tokens', () => ({ tokens: db.apiTokens }));
on('DELETE', '/api-tokens/:id', ({ params }) => { db.apiTokens = db.apiTokens.filter(t => t.id !== params.id); return ok(); });
on('GET', '/ai/status', () => ({ enabled: false, features: {} }));
on('GET', '/integrations', () => ({}));
on('GET', '/integrations/status', () => ({ google: { configured: false }, microsoft: { configured: false } }));
on('GET', '/secure-messages', () => ({ messages: [] }));
on('GET', '/admin/settings', () => ({}));
on('GET', '/update', () => ({ updateAvailable: false }));
on('GET', '/version', () => ({ version: 'demo' }));
on('GET', '/health', () => ok());

// Accounts and folders
on('GET', '/accounts', () => db.accounts);
on('PUT', '/accounts/:id', ({ params, body }) => Object.assign(accountById(params.id) || notFound(), body || {}));
on('PATCH', '/accounts/order', ({ body }) => { (body?.ids || []).forEach((id, i) => { const a = accountById(id); if (a) a.sort_order = i; }); db.accounts.sort((a, b) => a.sort_order - b.sort_order); return ok(); });
on('POST', '/accounts/:id/reconnect', () => ok({ connected: true }));
on('POST', '/accounts/:id/reindex', () => ok({ alreadyRunning: false }));
on('GET', '/accounts/:id/folders', ({ params }) => (db.folders[params.id] || notFound()).map(f => folderRow(params.id, f)));
on('GET', '/accounts/:id/aliases', () => []);
on('POST', '/mail/folders', ({ body }) => {
  const list = db.folders[body.accountId] || notFound();
  const path = body.parentPath ? `${body.parentPath}/${body.name}` : body.name;
  if (!list.some(f => f.path === path)) list.push({ path, name: body.name, special: null });
  return ok({ path });
});
on('POST', '/mail/folders/delete', ({ body }) => { db.folders[body.accountId] = (db.folders[body.accountId] || []).filter(f => f.path !== body.path && !f.path.startsWith(`${body.path}/`)); return ok(); });
on('POST', '/mail/folders/rename', ({ body }) => {
  const f = (db.folders[body.accountId] || []).find(x => x.path === body.oldPath) || notFound();
  const newPath = f.path.includes('/') ? `${f.path.slice(0, f.path.lastIndexOf('/'))}/${body.newName}` : body.newName;
  for (const m of live()) if (m.account_id === body.accountId && m.folder === f.path) m.folder = newPath;
  Object.assign(f, { path: newPath, name: body.newName });
  return ok({ newPath });
});
on('POST', '/mail/folders/empty', ({ body }) => { for (const m of live()) if (m.account_id === body.accountId && m.folder === body.path) m.deleted = true; return ok(); });

// Messages
on('GET', '/mail/messages', ({ query }) => listMessages(query));
on('GET', '/mail/unread-counts', () => unreadCounts());
on('GET', '/mail/category-counts', () => ({ counts: {}, totals: {} }));
on('GET', '/mail/thread', ({ query }) => threadOf(query.id));
on('GET', '/mail/resolve-message', ({ query }) => rowOf(live().find(m => m.message_id === query.ref || m.id === query.ref) || notFound()));
on('GET', '/mail/messages/:id', ({ params }) => rowOf(messageById(params.id)));
on('GET', '/mail/messages/:id/reactions', ({ params }) => {
  const target = messageById(params.id);
  return { reactions: live().filter(m => m.reaction_emoji && m.account_id === target.account_id && m.in_reply_to === target.message_id).map(rowOf) };
});
on('GET', '/mail/messages/:id/body', ({ params }) => bodyOf(messageById(params.id)));
on('GET', '/mail/messages/:id/headers', ({ params }) => headersOf(messageById(params.id)));
on('GET', '/mail/messages/:id/bcc', () => ({ bcc: [] }));
on('GET', '/mail/messages/:id/receipt', () => ({ requested: false }));
on('GET', '/mail/messages/:id/raw.eml', ({ params }) => new Blob([rawEml(messageById(params.id))], { type: 'message/rfc822' }));
on('GET', '/mail/messages/:id/attachments/:part', ({ params }) => attachmentOf(messageById(params.id), decodeURIComponent(params.part)));
on('PATCH', '/mail/messages/:id/read', ({ params, body }) => { const m = messageById(params.id); m.is_read = body?.read !== false; return ok({ is_read: m.is_read }); });
on('PATCH', '/mail/messages/:id/star', ({ params, body }) => { const m = messageById(params.id); m.is_starred = !!body?.starred; return ok({ is_starred: m.is_starred }); });
on('PATCH', '/mail/messages/:id/category', ({ params, body }) => { messageById(params.id).category = body?.category || null; return ok({ category: body?.category }); });
on('POST', '/mail/messages/bulk-read', ({ body }) => { const ids = body?.ids || []; for (const id of ids) messageById(id).is_read = !!body.read; return ok({ updated: ids }); });
on('POST', '/mail/messages/bulk-star', ({ body }) => { const ids = body?.ids || []; for (const id of ids) messageById(id).is_starred = !!body.starred; return ok({ updated: ids }); });
on('POST', '/mail/messages/bulk-delete', ({ body }) => { const ids = body?.ids || []; for (const id of ids) trash(messageById(id)); return ok({ deleted: ids }); });
on('POST', '/mail/messages/bulk-move', ({ body }) => { const ids = body?.ids || []; for (const id of ids) moveTo(messageById(id), body.folder); return ok({ moved: ids }); });
on('POST', '/mail/messages/bulk-archive', ({ body }) => { const ids = body?.ids || []; for (const id of ids) moveTo(messageById(id), 'Archive'); return ok({ archived: ids, noArchiveFolder: [] }); });
on('POST', '/mail/messages/:id/copy', ({ params, body }) => {
  const m = messageById(params.id);
  const copy = { ...m, id: newId(), body: { ...m.body } };
  db.messages.push(copy);
  moveTo(copy, body?.folder || 'Archive');
  return ok({ uid: copy.uid });
});
on('DELETE', '/mail/messages/:id', ({ params }) => { trash(messageById(params.id)); return ok(); });
on('POST', '/mail/messages/:id/spam', ({ params }) => { moveTo(messageById(params.id), 'Junk'); return ok({ folder: 'Junk' }); });
on('POST', '/mail/messages/:id/ham', ({ params }) => { moveTo(messageById(params.id), 'INBOX'); return ok({ folder: 'INBOX' }); });
on('POST', '/mail/messages/:id/unsubscribe', ({ params }) => { messageById(params.id).unsubscribed_at = iso(Date.now()); return ok({ type: 'one-click' }); });
on('POST', '/mail/messages/:id/snooze', ({ params }) => { messageById(params.id); throw new HttpError(422, 'Snoozing is not available in the demo'); });
on('POST', '/mail/mark-all-read', ({ body }) => {
  for (const m of live()) if ((!body?.accountId || m.account_id === body.accountId) && m.folder === (body?.folder || 'INBOX')) m.is_read = true;
  return ok();
});
on('POST', '/mail/sync', () => ok());
on('POST', '/mail/sync-folder', () => ok());
on('POST', '/mail/sync-folders', () => ok());
on('POST', '/mail/send', ({ body }) => send(body));
on('POST', '/mail/send/reaction', ({ body }) => sendReaction(body));
on('GET', '/mail/send/:id', () => ({ status: 'sent' }));
on('POST', '/mail/draft', ({ body }) => saveDraft(body));
on('DELETE', '/mail/draft/:uid', ({ params, query }) => {
  const m = live().find(x => x.account_id === query.accountId && x.folder === (query.folder || 'Drafts') && String(x.uid) === params.uid);
  if (m) m.deleted = true;
  return ok();
});
on('POST', '/mail/reply-drafts/indicators', () => ({ indicators: {} }));
on('GET', '/mail/scheduled', () => ({ messages: [], moreSent: false }));
on('GET', '/mail/scheduled/count', () => ({ count: 0 }));
on('GET', '/search', ({ query }) => search(query));
on('GET', '/search/contacts', ({ query }) => suggestContacts(query));

// Contacts
on('GET', '/contacts', ({ query }) => listContacts(query));
on('GET', '/contacts/:id', ({ params }) => db.contacts.find(c => c.id === params.id) || notFound());
on('POST', '/contacts', ({ body }) => {
  const c = { id: newId(), uid: `demo-${seq}`, display_name: body?.display_name || body?.primary_email || 'New contact', first_name: body?.first_name || null, last_name: body?.last_name || null,
    primary_email: body?.primary_email || body?.emails?.[0]?.value || null, emails: body?.emails || [], phones: body?.phones || [], organization: body?.organization || null,
    notes: body?.notes || null, is_auto: false, send_count: 0, last_sent: null, etag: `etag-${seq}`, created_at: iso(Date.now()), updated_at: iso(Date.now()), has_contact_photo: false };
  db.contacts.push(c);
  return c;
});
on('PATCH', '/contacts/:id', ({ params, body }) => Object.assign(db.contacts.find(c => c.id === params.id) || notFound(), body || {}, { updated_at: iso(Date.now()) }));
on('DELETE', '/contacts/:id', ({ params }) => { db.contacts = db.contacts.filter(c => c.id !== params.id); return ok(); });
on('GET', '/contact-groups', () => ({ groups: db.groups.map(groupView) }));
on('GET', '/contact-groups/suggest', ({ query }) => ({ groups: db.groups.filter(g => g.name.toLowerCase().includes(String(query.q || '').toLowerCase())).map(groupView) }));
on('GET', '/contact-groups/:id', ({ params }) => {
  const g = db.groups.find(x => x.id === params.id) || notFound();
  return { id: g.id, name: g.name, source: g.source, members: g.members.map(id => db.contacts.find(c => c.id === id)).filter(Boolean).map(c => ({ id: c.id, display_name: c.display_name, primary_email: c.primary_email, has_contact_photo: false })) };
});
on('POST', '/contact-groups', ({ body }) => { const g = { id: newId(), name: body?.name || 'New group', source: 'local', members: [], created_at: iso(Date.now()), updated_at: iso(Date.now()) }; db.groups.push(g); return { ...groupView(g) }; });
on('PATCH', '/contact-groups/:id', ({ params, body }) => { const g = db.groups.find(x => x.id === params.id) || notFound(); g.name = body?.name || g.name; return groupView(g); });
on('DELETE', '/contact-groups/:id', ({ params }) => { db.groups = db.groups.filter(g => g.id !== params.id); return ok(); });
on('POST', '/contact-groups/:id/members', ({ params, body }) => { const g = db.groups.find(x => x.id === params.id) || notFound(); g.members = [...new Set([...g.members, ...(body?.contactIds || [])])]; return ok({ added: body?.contactIds?.length || 0 }); });
on('DELETE', '/contact-groups/:id/members/:cid', ({ params }) => { const g = db.groups.find(x => x.id === params.id) || notFound(); g.members = g.members.filter(m => m !== params.cid); return ok(); });

// Calendar
const calAccount = a => ({ ...a, lastSyncAt: iso(started - 120_000), lastError: null, calendarCount: db.calendars.filter(c => c.accountId === a.id).length, eventCount: db.events.filter(e => db.calendars.find(c => c.id === e.calendarId)?.accountId === a.id).length });
on('GET', '/calendar/accounts', () => CALENDAR_ACCOUNTS.map(calAccount));
on('GET', '/calendar/mail-accounts', () => db.accounts.map(a => ({ id: a.id, email: a.email_address, host: a.imap_host, username: a.auth_user, connected: true })));
on('POST', '/calendar/accounts/:id/sync', ({ params }) => ({ ok: true, account: calAccount(CALENDAR_ACCOUNTS.find(a => a.id === params.id) || notFound()) }));
on('PATCH', '/calendar/accounts/:id', ({ params, body }) => calAccount(Object.assign(CALENDAR_ACCOUNTS.find(a => a.id === params.id) || notFound(), body || {})));
on('GET', '/calendar/calendars', ({ query }) => db.calendars.filter(c => query.all === '1' || !c.ignored));
on('PATCH', '/calendar/calendars/:id', ({ params, body }) => {
  const c = db.calendars.find(x => x.id === params.id) || notFound();
  if (typeof body?.visible === 'boolean') c.visible = body.visible;
  if (body?.color) c.color = body.color;
  if (body?.displayName !== undefined) { c.displayName = body.displayName || null; c.name = body.displayName || c.serverName; }
  if (typeof body?.ignored === 'boolean') c.ignored = body.ignored;
  return c;
});
on('GET', '/calendar/events', ({ query }) => eventsBetween(query));
on('GET', '/calendar/events/search', ({ query }) => {
  const q = String(query.q || '').toLowerCase();
  return { events: db.events.filter(e => `${e.summary} ${e.location || ''}`.toLowerCase().includes(q)).slice(0, 50), truncated: false };
});
on('POST', '/calendar/events', ({ body }) => {
  const eventId = newId();
  db.events.push({
    id: `${eventId}:`, eventId, calendarId: body?.calendarId || db.calendars[0].id, readOnly: false, uid: `demo-${eventId}`,
    summary: body?.summary || '', location: body?.location || null, description: body?.description || null, url: null,
    allDay: !!body?.allDay, start: body?.start, end: body?.end, timezone: body?.timezone || null, status: 'CONFIRMED',
    organizer: body?.attendees?.length ? { name: USER.displayName, email: ACCOUNTS[0].email } : null,
    attendees: (body?.attendees || []).map(a => ({ name: a.name || null, email: a.email, status: 'NEEDS-ACTION' })),
    reminderMinutes: body?.reminderMinutes ?? null, recurrence: body?.recurrence || null, custom: false, recurrenceId: null,
    organizerIsMe: true, myStatus: null,
  });
  return ok({ eventId });
});
on('PATCH', '/calendar/events/:id', ({ params, body }) => {
  for (const e of db.events.filter(x => x.eventId === params.id)) {
    for (const k of ['summary', 'location', 'description', 'allDay', 'start', 'end', 'timezone', 'reminderMinutes', 'calendarId']) if (body?.[k] !== undefined) e[k] = body[k];
  }
  return ok();
});
on('DELETE', '/calendar/events/:id', ({ params }) => { db.events = db.events.filter(e => e.eventId !== params.id); return ok(); });
on('POST', '/calendar/events/:id/reply', ({ params, body }) => {
  for (const e of db.events.filter(x => x.eventId === params.id)) {
    e.myStatus = body?.status || body?.partstat || 'ACCEPTED';
    e.attendees = e.attendees.map(a => (a.email === ACCOUNTS[0].email ? { ...a, status: e.myStatus } : a));
  }
  return ok();
});

// Server filters and out-of-office (Sieve), OpenPGP, rules
on('GET', '/sieve/:accountId', ({ params }) => sieveState(params.accountId));
on('POST', '/sieve/:accountId/check', () => ok({ errors: [] }));
on('PUT', '/sieve/:accountId/rules', ({ params, body }) => { db.sieve[params.accountId].rules = body?.rules || []; return sieveState(params.accountId); });
on('PUT', '/sieve/:accountId/vacation', ({ params, body }) => { db.sieve[params.accountId].vacation = body?.vacation ?? body ?? null; return sieveState(params.accountId); });
on('GET', '/pgp/keys', () => ownKeys());
on('GET', '/pgp/keyring', () => ({ keys: db.keyring.map(k => ({ ...k, lastSeen: k.last_seen })) }));
on('GET', '/pgp/kdf', () => ({ salt: 'ZGVtby1zYWx0LW5vdC1zZWNyZXQ=' }));
on('POST', '/pgp/lookup', ({ body }) => pgpLookup(body));
on('POST', '/pgp/keyring', () => ok());
on('PATCH', '/pgp/keys/:id', () => ok());
on('GET', '/rules', () => db.rules);
on('POST', '/rules/run', () => ok({ matched: 0 }));

// What the demo does not do answers as the server does when a feature is off.
const UNAVAILABLE = /^\/(admin|backup|diagnostics|mail-transfer|oauth|totp|auth\/2fa|auth\/avatar|auth\/password|passkeys\/registration|api-tokens$|secure-messages$|signature-images|auth\/lock)/;

export async function handle(method, path, query, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = r.re.exec(path);
    if (!match) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
    return r.handler({ params, query, body });
  }
  if (method !== 'GET' && UNAVAILABLE.test(path)) throw new HttpError(403, 'This is not available in the demo.');
  if (method === 'GET') {
    console.info(`[demo] no fake answer for GET ${path}`);
    throw new HttpError(404, 'Not available in the demo');
  }
  console.info(`[demo] no fake answer for ${method} ${path}`);
  return ok();
}

export { HttpError };
