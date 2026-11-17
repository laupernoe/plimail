// The Sieve script (RFC 5228) Plimail keeps on the server under the name `plimail`, built from
// simple rules: when the sender, the subject or a recipient contains some text, file the message
// into a folder, mark it read, delete it or redirect it. The rules ride along in a comment so the
// editor can show them again; a script edited by hand has no such comment and is left to the raw
// editor.

export const PLIMAIL_SCRIPT = 'plimail';
export const MAX_RULES = 100;
const MAX_TEXT = 200;
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

// The extensions a set of rules needs.
export function requiredExtensions(rules) {
  const need = new Set();
  for (const r of rules) {
    if (r.action === 'move' || r.action === 'delete') need.add('fileinto');
    if (r.action === 'markRead') need.add('imap4flags');
  }
  return [...need].sort();
}

function encodeMeta(meta) {
  return Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
}

// The rules a Plimail-written script carries, or null for a script without the comment (one
// written elsewhere or edited by hand).
export function readPlimailMeta(script) {
  if (typeof script !== 'string') return null;
  const line = script.split(/\r?\n/).find(l => l.startsWith(META_PREFIX));
  if (!line) return null;
  try {
    const meta = JSON.parse(Buffer.from(line.slice(META_PREFIX.length).trim(), 'base64').toString('utf8'));
    if (!meta || meta.v !== 1 || !Array.isArray(meta.rules)) return null;
    const checked = validateRules(meta.rules);
    return checked.error ? null : { rules: checked.rules };
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

// The script for `rules` (already validated). `trashFolder` is where 'delete' files mail.
// Throws when a rule needs an extension the server lacks, or a delete rule has no Trash.
export function buildPlimailScript({ rules = [] }, { extensions = [], trashFolder = null } = {}) {
  const need = requiredExtensions(rules);
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
    `${META_PREFIX}${encodeMeta({ v: 1, rules })}`,
  ];
  if (need.length) lines.push(`require [${need.map(sieveQuote).join(', ')}];`);
  for (const rule of rules) lines.push('', ...ruleBlock(rule, { trashFolder }));
  return `${lines.join('\r\n')}\r\n`;
}
