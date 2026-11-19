import { describe, it, expect } from 'vitest';
import {
  detectReactionParts, parseGmailReaction, parseRfc9078Reaction, reactionEmojiFromParts, isEmojiSequence, parseMessage,
} from './messageParser.js';

// BODYSTRUCTURE as imapflow returns it.
const text = (part, extra = {}) => ({ part, type: 'text/plain', parameters: { charset: 'utf-8' }, encoding: 'base64', size: 8, ...extra });
const html = part => ({ part, type: 'text/html', parameters: { charset: 'utf-8' }, encoding: 'quoted-printable', size: 400 });
const gmailJson = (part, extra = {}) => ({ part, type: 'text/vnd.google.email-reaction+json', parameters: { charset: 'UTF-8' }, encoding: '7bit', size: 34, ...extra });

describe('detectReactionParts', () => {
  it('finds an RFC 9078 reaction that is the whole body (part 1)', () => {
    const structure = { type: 'text/plain', parameters: { charset: 'utf-8' }, encoding: '8bit', size: 6, disposition: 'reaction' };
    expect(detectReactionParts(structure)).toEqual([{ type: 'rfc9078', part: '1', encoding: '8bit', charset: 'utf-8' }]);
  });

  it('finds the Gmail JSON part of a multipart/alternative, inside a nested multipart too', () => {
    const structure = { type: 'multipart/alternative', childNodes: [text('1'), gmailJson('2'), html('3')] };
    expect(detectReactionParts(structure)).toEqual([{ type: 'json', part: '2', encoding: '7bit', charset: 'utf-8' }]);
    const nested = { type: 'multipart/mixed', childNodes: [{ type: 'multipart/alternative', part: '1', childNodes: [text('1.1'), gmailJson('1.2'), html('1.3')] }] };
    expect(detectReactionParts(nested)).toEqual([{ type: 'json', part: '1.2', encoding: '7bit', charset: 'utf-8' }]);
  });

  it('finds both parts of the format Plimail sends, the Gmail one first', () => {
    const structure = { type: 'multipart/alternative', childNodes: [text('1', { disposition: 'reaction' }), gmailJson('2', { encoding: 'base64' }), html('3')] };
    expect(detectReactionParts(structure)).toEqual([
      { type: 'json', part: '2', encoding: 'base64', charset: 'utf-8' },
      { type: 'rfc9078', part: '1', encoding: 'base64', charset: 'utf-8' },
    ]);
  });

  it('finds nothing in an ordinary message', () => {
    expect(detectReactionParts({ type: 'multipart/alternative', childNodes: [text('1'), html('2')] })).toBeNull();
    expect(detectReactionParts({ type: 'text/plain', parameters: {}, encoding: '7bit', size: 3 })).toBeNull();
    expect(detectReactionParts(null)).toBeNull();
  });

  it('ignores a reaction part sent as an attachment, out of place, or too big to be one', () => {
    expect(detectReactionParts({ type: 'multipart/mixed', childNodes: [text('1'), gmailJson('2', { disposition: 'attachment' })] })).toBeNull();
    // RFC 9078 section 4: the first body part of the outermost multipart, nowhere else.
    expect(detectReactionParts({ type: 'multipart/mixed', childNodes: [html('1'), text('2', { disposition: 'reaction' })] })).toBeNull();
    expect(detectReactionParts({ type: 'multipart/alternative', childNodes: [text('1'), gmailJson('2', { size: 50_000 })] })).toBeNull();
  });
});

describe('reaction content', () => {
  it('accepts Gmail JSON with version 1 and exactly one emoji', () => {
    expect(parseGmailReaction('{"version":1,"emoji":"👍"}')).toBe('👍');
    expect(parseGmailReaction('{\n  "emoji": "👍🏽",\n  "version": 1\n}')).toBe('👍🏽');
    expect(parseGmailReaction('{"version":1,"emoji":"👩‍👩‍👧"}')).toBe('👩‍👩‍👧');
  });

  it('refuses malformed JSON, another version, no emoji or more than one', () => {
    for (const bad of ['not json', '{"emoji":"👍"}', '{"version":2,"emoji":"👍"}', '{"version":"1","emoji":"👍"}',
      '{"version":1,"emoji":""}', '{"version":1,"emoji":"👍👍"}', '{"version":1,"emoji":"ok"}', '{"version":1,"emoji":"1"}']) {
      expect(parseGmailReaction(bad), bad).toBeNull();
    }
  });

  it('accepts an RFC 9078 line of emoji and refuses anything else in it', () => {
    expect(parseRfc9078Reaction('👍\r\n')).toBe('👍');
    expect(parseRfc9078Reaction('👍 🎉\r\n')).toBe('👍 🎉');
    expect(parseRfc9078Reaction('❤️')).toBe('❤️');
    expect(parseRfc9078Reaction('👍 thanks\r\n')).toBeNull();
    expect(parseRfc9078Reaction('👍\r\n👍\r\n')).toBeNull();
    expect(parseRfc9078Reaction('')).toBeNull();
  });

  it('takes the first valid part, and gives an empty string when none is', () => {
    const parts = [{ type: 'json', part: '2' }, { type: 'rfc9078', part: '1' }];
    expect(reactionEmojiFromParts(parts, new Map([['2', '{"version":1,"emoji":"🎉"}'], ['1', '👍\r\n']]))).toBe('🎉');
    expect(reactionEmojiFromParts(parts, new Map([['2', '{"version":3}'], ['1', '👍\r\n']]))).toBe('👍');
    expect(reactionEmojiFromParts(parts, new Map([['2', '{}'], ['1', 'Sounds good']]))).toBe('');
  });

  it('knows an emoji from a letter, a digit or punctuation', () => {
    for (const ok of ['👍', '❤️', '🇨🇭', '1️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🧑🏽‍💻']) expect(isEmojiSequence(ok), ok).toBe(true);
    for (const bad of ['a', '1', '!', '👍 👍', ' 👍', '<b>', '']) expect(isEmojiSequence(bad), bad).toBe(false);
  });
});

describe('parseMessage', () => {
  const structure = { type: 'multipart/alternative', childNodes: [text('1'), gmailJson('2'), html('3')] };
  const msg = inReplyTo => ({
    uid: 7, flags: new Set(), bodyStructure: structure, headers: Buffer.from(''),
    envelope: { messageId: '<r@example.com>', inReplyTo, subject: 'Re: Hi', from: [{ name: 'Jo', address: 'jo@example.com' }], to: [] },
  });

  it('reports the reaction parts of a reply', async () => {
    expect((await parseMessage(msg('<orig@example.com>'))).reaction).toEqual([{ type: 'json', part: '2', encoding: '7bit', charset: 'utf-8' }]);
  });

  it('reports none for a message that replies to nothing', async () => {
    expect((await parseMessage(msg(undefined))).reaction).toBeNull();
  });
});
