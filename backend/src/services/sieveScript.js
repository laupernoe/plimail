// The Sieve script (RFC 5228) Plimail keeps on the server under the name `plimail`, built from
// simple rules: when the sender, the subject or a recipient contains some text, file the message
// into a folder, mark it read, delete it or redirect it. It also carries the out-of-office reply
// (RFC 5230 vacation), since a server runs only one active script. The rules and the reply ride
// along in a comment so the editor can show them again; a script edited by hand has no such
// comment and is left to the raw editor.

export const PLIMAIL_SCRIPT = 'plimail';
export const MAX_RULES = 100;
const MAX_TEXT = 200;
const MAX_VACATION_BODY = 4000;
const MAX_VACATION_ADDRESSES = 20;
// RFC 5230 asks servers to accept at least 1 to 30 days; some refuse more.
export const VACATION_DAYS = { min: 1, max: 30, default: 7 };
const META_PREFIX = '# plimail-meta: ';

const FIELDS = {
  from: '"from"',
  subject: '"subject"',
  recipient: '["to", "cc"]',
};
export const RULE_FIELDS = Object.keys(FIELDS);
export const RULE_ACTIONS = ['move', 'markRead', 'delete', 'redirect'];
const EMAIL_RE = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]+$/;

const hasControl = s => [...s].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

// A Sieve quoted string: only backslash and double quote need escaping (RFC 5228 2.4.2).
export function sieveQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > MAX_TEXT || hasControl(s)) return null;
  return s;
}

// Checks rules from the client and returns them in canonical form, or { error, index }.
export function validateRules(input) {
  if (!Array.isArray(input)) return { error: 'Rules must be a list' };
  if (input.length > MAX_RULES) return { error: `At most ${MAX_RULES} rules` };
  const rules = [];
  for (const [index, rule] of input.entries()) {
    if (!rule || typeof rule !== 'object') return { error: 'Invalid rule', index };
    if (!RULE_FIELDS.includes(rule.field)) return { error: 'Unknown field', index };
    if (!RULE_ACTIONS.includes(rule.action)) return { error: 'Unknown action', index };
    const contains = cleanText(rule.contains);
    if (!contains) return { error: 'Each rule needs the text to look for', index };
    const out = { field: rule.field, contains, action: rule.action };
    if (rule.action === 'move') {
      const folder = cleanText(rule.folder);
      if (!folder) return { error: 'Choose a folder', index };
      out.folder = folder;
    }
    if (rule.action === 'redirect') {
      const address = cleanText(rule.address);
      if (!address || !EMAIL_RE.test(address)) return { error: 'Enter a valid address to redirect to', index };
      out.address = address;
    }
    rules.push(out);
  }
  return { rules };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(value) {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// Checks the out-of-office reply from the client and returns it in canonical form, or { error }.
// A reply that is off keeps its text, so turning it on again later needs no retyping.
export function validateVacation(input) {
  if (!input || typeof input !== 'object') return { error: 'Invalid out-of-office reply' };
  const enabled = input.enabled === true;
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  if (subject.length > MAX_TEXT || hasControl(subject)) return { error: 'Invalid subject' };
  const body = typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').trim() : '';
  if (body.length > MAX_VACATION_BODY || [...body].some(ch => ch !== '\n' && ch !== '\t' && hasControl(ch))) {
    return { error: 'Invalid message' };
  }
  if (enabled && !body) return { error: 'Write the message to send' };
  const start = input.start || null;
  const end = input.end || null;
  if ((start !== null && !validDate(start)) || (end !== null && !validDate(end))) return { error: 'Invalid date' };
  if (start && end && end < start) return { error: 'The end date is before the start date' };
  const days = input.days === undefined || input.days === null || input.days === '' ? VACATION_DAYS.default : Number(input.days);
  if (!Number.isInteger(days) || days < VACATION_DAYS.min || days > VACATION_DAYS.max) {
    return { error: `Days must be between ${VACATION_DAYS.min} and ${VACATION_DAYS.max}` };
  }
  const rawAddresses = input.addresses ?? [];
  if (!Array.isArray(rawAddresses) || rawAddresses.length > MAX_VACATION_ADDRESSES) return { error: 'Invalid addresses' };
  const addresses = [];
  for (const a of rawAddresses) {
    const address = cleanText(a);
    if (!address || !EMAIL_RE.test(address)) return { error: 'Enter valid addresses' };
    if (!addresses.includes(address)) addresses.push(address);
  }
  return { vacation: { enabled, subject, body, start, end, days, addresses } };
}

// The extensions a set of rules and an out-of-office reply need.
export function requiredExtensions(rules, vacation = null) {
  const need = new Set();
  for (const r of rules) {
    if (r.action === 'move' || r.action === 'delete') need.add('fileinto');
    if (r.action === 'markRead') need.add('imap4flags');
  }
  if (vacation?.enabled) {
    need.add('vacation');
    if (vacation.start || vacation.end) { need.add('date'); need.add('relational'); }
  }
  return [...need].sort();
}

function encodeMeta(meta) {
  return Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
}

// The rules and reply a Plimail-written script carries, or null for a script without the comment
// (one written elsewhere or edited by hand).
export function readPlimailMeta(script) {
  if (typeof script !== 'string') return null;
  const line = script.split(/\r?\n/).find(l => l.startsWith(META_PREFIX));
  if (!line) return null;
  try {
    const meta = JSON.parse(Buffer.from(line.slice(META_PREFIX.length).trim(), 'base64').toString('utf8'));
    if (!meta || meta.v !== 1 || !Array.isArray(meta.rules)) return null;
    const checked = validateRules(meta.rules);
    if (checked.error) return null;
    if (meta.vacation == null) return { rules: checked.rules, vacation: null };
    const vacation = validateVacation(meta.vacation);
    return vacation.error ? null : { rules: checked.rules, vacation: vacation.vacation };
  } catch {
    return null;
  }
}

function ruleBlock(rule, { trashFolder }) {
  const test = `header :contains ${FIELDS[rule.field]} ${sieveQuote(rule.contains)}`;
  let actions;
  if (rule.action === 'move') actions = [`fileinto ${sieveQuote(rule.folder)};`, 'stop;'];
  else if (rule.action === 'markRead') actions = ['addflag "\\\\Seen";'];
  // Deleting files the message into Trash rather than discarding it: a rule that matches more
  // than intended must not destroy mail the user never saw.
  else if (rule.action === 'delete') actions = [`fileinto ${sieveQuote(trashFolder)};`, 'stop;'];
  else actions = [`redirect ${sieveQuote(rule.address)};`, 'stop;'];
  return [`if ${test} {`, ...actions.map(a => `  ${a}`), '}'];
}

// The reply comes before the rules, so mail a rule files away and stops on is still answered.
// The server itself skips mailing lists, bulk mail and senders it already answered within
// `days` (RFC 5230 4.2, 4.5).
function vacationBlock(vacation) {
  const args = [`:days ${vacation.days}`];
  if (vacation.subject) args.push(`:subject ${sieveQuote(vacation.subject)}`);
  if (vacation.addresses.length) args.push(`:addresses [${vacation.addresses.map(sieveQuote).join(', ')}]`);
  const command = `vacation ${args.join(' ')} ${sieveQuote(vacation.body.replace(/\n/g, '\r\n'))};`;
  const tests = [];
  if (vacation.start) tests.push(`currentdate :value "ge" "date" ${sieveQuote(vacation.start)}`);
  if (vacation.end) tests.push(`currentdate :value "le" "date" ${sieveQuote(vacation.end)}`);
  if (!tests.length) return [command];
  const test = tests.length === 1 ? tests[0] : `allof (${tests.join(', ')})`;
  return [`if ${test} {`, `  ${command}`, '}'];
}

// The script for `rules` and `vacation` (already validated). `trashFolder` is where 'delete'
// files mail. Throws when something needs an extension the server lacks, or a delete rule has no
// Trash.
export function buildPlimailScript({ rules = [], vacation = null }, { extensions = [], trashFolder = null } = {}) {
  const need = requiredExtensions(rules, vacation);
  const missing = need.filter(e => !extensions.includes(e));
  if (missing.length) {
    throw Object.assign(new Error(`The server does not support: ${missing.join(', ')}`), { code: 'extension_missing', missing });
  }
  if (rules.some(r => r.action === 'delete') && !trashFolder) {
    throw Object.assign(new Error('No Trash folder to delete into'), { code: 'no_trash' });
  }
  const lines = [
    '# Server filters written by Plimail. Edit them in Plimail: changes made here by hand',
    '# are replaced the next time the rules are saved there.',
    `${META_PREFIX}${encodeMeta(vacation ? { v: 1, rules, vacation } : { v: 1, rules })}`,
  ];
  if (need.length) lines.push(`require [${need.map(sieveQuote).join(', ')}];`);
  if (vacation?.enabled) lines.push('', ...vacationBlock(vacation));
  for (const rule of rules) lines.push('', ...ruleBlock(rule, { trashFolder }));
  return `${lines.join('\r\n')}\r\n`;
}
