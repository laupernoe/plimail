import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import {
  reactionBlocker, reactionRecipients, reactionSubject, reactionReferences, resolveReactionEmoji, recordReactionParts,
  _resetReactionState,
} from './reactions.js';

const own = new Set(['me@example.com', 'alias@example.com']);
const msg = (extra = {}) => ({
  id: 'm1', message_id: '<orig@example.com>', from_name: 'Jo', from_email: 'jo@example.com',
  to_addresses: [{ name: 'Me', email: 'me@example.com' }], cc_addresses: [{ name: 'Kim', email: 'kim@example.com' }],
  reply_to: [], is_draft: false, is_bulk: false, list_unsubscribe: null, reaction_emoji: null, ...extra,
});

describe('reactionBlocker', () => {
  it('allows a message the reader received in To or Cc, or wrote', () => {
    expect(reactionBlocker(msg(), own)).toBeNull();
    expect(reactionBlocker(msg({ to_addresses: [], cc_addresses: [{ email: 'ALIAS@example.com' }] }), own)).toBeNull();
    expect(reactionBlocker(msg({ from_email: 'me@example.com', to_addresses: [{ email: 'jo@example.com' }] }), own)).toBeNull();
  });

  it('refuses what Gmail says not to react to', () => {
    expect(reactionBlocker(msg({ is_draft: true }), own)).toBe('draft');
    expect(reactionBlocker(msg({ message_id: null }), own)).toBe('no_message_id');
    expect(reactionBlocker(msg({ reaction_emoji: '👍' }), own)).toBe('is_reaction');
    expect(reactionBlocker(msg({ list_unsubscribe: '<https://list.example.com/u>' }), own)).toBe('mailing_list');
    expect(reactionBlocker(msg({ is_bulk: true }), own)).toBe('mailing_list');
    const many = Array.from({ length: 21 }, (_, i) => ({ email: `p${i}@example.com` }));
    expect(reactionBlocker(msg({ to_addresses: [{ email: 'me@example.com' }, ...many] }), own)).toBe('too_many_recipients');
    // Bcc'd: the reader is in neither To nor Cc.
    expect(reactionBlocker(msg({ to_addresses: [{ email: 'other@example.com' }], cc_addresses: [] }), own)).toBe('not_a_recipient');
  });
});

describe('reaction addressing', () => {
  it('replies to all, without the reader', () => {
    expect(reactionRecipients(msg(), own)).toEqual({ to: ['"Jo" <jo@example.com>'], cc: ['"Kim" <kim@example.com>'] });
  });

  it('goes to the Reply-To, and on the reader\'s own message to its recipients', () => {
    expect(reactionRecipients(msg({ reply_to: [{ name: '', email: 'desk@example.com' }] }), own).to).toEqual(['desk@example.com']);
    const mine = msg({ from_email: 'me@example.com', to_addresses: [{ name: 'Jo "J"', email: 'jo@example.com' }], cc_addresses: [] });
    expect(reactionRecipients(mine, own)).toEqual({ to: ['"Jo J" <jo@example.com>'], cc: [] });
  });

  it('threads as a reply', () => {
    expect(reactionSubject('Hi')).toBe('Re: Hi');
    expect(reactionSubject('RE: Hi')).toBe('RE: Hi');
    expect(reactionReferences(msg({ thread_references: '<root@example.com>' }))).toBe('<root@example.com> <orig@example.com>');
    expect(reactionReferences(msg({ thread_references: null }))).toBe('<orig@example.com>');
  });
});

describe('recordReactionParts', () => {
  beforeEach(() => query.mockReset());

  it('never overwrites parts already recorded, so a read emoji is not reset by the next sync', async () => {
    query.mockResolvedValue({ rows: [] });
    await recordReactionParts('a1', 'INBOX', 9, [{ type: 'json', part: '2' }]);
    expect(query.mock.calls[0][0]).toMatch(/reaction_parts IS NULL/);
    expect(query.mock.calls[0][1]).toEqual(['a1', 'INBOX', 9, '[{"type":"json","part":"2"}]']);
  });
});

describe('resolveReactionEmoji', () => {
  beforeEach(() => {
    query.mockReset();
    _resetReactionState();
    query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [{ id: 'a1' }] : [] }));
  });
  const row = (extra = {}) => ({
    id: 'r1', account_id: 'a1', uid: 4, folder: 'INBOX', reaction_emoji: null,
    reaction_parts: [{ type: 'json', part: '2', encoding: '7bit', charset: 'utf-8' }, { type: 'rfc9078', part: '1', encoding: 'base64', charset: 'utf-8' }],
    ...extra,
  });

  it('reads the parts once and stores the emoji', async () => {
    const engine = { fetchMultipleAttachments: vi.fn(async () => new Map([['2', Buffer.from('{"version":1,"emoji":"🎉"}')]])) };
    const rows = [row(), { id: 'plain', reaction_parts: null, reaction_emoji: null }];
    await resolveReactionEmoji(rows, { engine });
    expect(rows[0].reaction_emoji).toBe('🎉');
    expect(engine.fetchMultipleAttachments).toHaveBeenCalledTimes(1);
    expect(engine.fetchMultipleAttachments.mock.calls[0].slice(1)).toEqual([4, 'INBOX', [{ part: '2', encoding: '7bit' }, { part: '1', encoding: 'base64' }]]);
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE messages'));
    expect(update[1]).toEqual(['r1', '🎉']);
  });

  it('stores an empty emoji for a part that is not a valid reaction, so it shows as mail', async () => {
    const engine = { fetchMultipleAttachments: vi.fn(async () => new Map([['1', Buffer.from('See you then')]])) };
    const rows = [row()];
    await resolveReactionEmoji(rows, { engine });
    expect(rows[0].reaction_emoji).toBe('');
  });

  it('leaves the emoji unknown when the server returns nothing, and does not ask again at once', async () => {
    const engine = { fetchMultipleAttachments: vi.fn(async () => new Map()) };
    const rows = [row()];
    await resolveReactionEmoji(rows, { engine });
    await resolveReactionEmoji(rows, { engine });
    expect(rows[0].reaction_emoji).toBeNull();
    expect(engine.fetchMultipleAttachments).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE messages'))).toBe(false);
  });

  it('answers within its time limit when the server is slow', async () => {
    const engine = { fetchMultipleAttachments: vi.fn(() => new Promise(() => {})) };
    const rows = [row()];
    await resolveReactionEmoji(rows, { engine, timeoutMs: 20 });
    expect(rows[0].reaction_emoji).toBeNull();
  });
});
