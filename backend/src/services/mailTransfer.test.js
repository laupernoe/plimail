import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
  mboxFromLine, mboxrdEscape, mboxrdUnescape, parseMbox, parseFromLineDate, internalDateOf,
  messageIdOf, subjectOf, looksLikeMessage, toCrlf, MailTransferFormatError, mboxFlagsOf, withMboxStatus,
} from './mailTransfer.js';

const collect = async (stream, opts) => {
  const out = [];
  for await (const m of parseMbox(stream, opts)) out.push(m);
  return out;
};
const chunked = (str, size) => Readable.from((function* () {
  const buf = Buffer.from(str, 'latin1');
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
})());

describe('mboxrd escaping', () => {
  it('prefixes every From line, with or without existing > markers, and nothing else', () => {
    const raw = 'Subject: x\r\n\r\nFrom here\r\n>From there\r\n>>From deep\r\nnot From at start\r\nFrom';
    expect(mboxrdEscape(Buffer.from(raw)).toString()).toBe(
      'Subject: x\r\n\r\n>From here\r\n>>From there\r\n>>>From deep\r\nnot From at start\r\nFrom');
  });

  it('escapes a From line at the very start of the message', () => {
    expect(mboxrdEscape(Buffer.from('From me\r\n')).toString()).toBe('>From me\r\n');
  });

  it('is undone exactly by the unescape', () => {
    const raw = 'From a\r\n>From b\r\n>>From c\r\nFrom\r\n>Frome\r\nx';
    expect(mboxrdUnescape(mboxrdEscape(Buffer.from(raw))).toString()).toBe(raw);
  });

  it('does not touch a lone > line that is not a From line', () => {
    expect(mboxrdUnescape(Buffer.from('>quoted\r\n>From x\r\n')).toString()).toBe('>quoted\r\nFrom x\r\n');
  });
});

describe('the mbox From line', () => {
  it('writes the date in UTC asctime form', () => {
    expect(mboxFromLine(new Date(Date.UTC(1996, 0, 3, 1, 5, 34)))).toBe('From MAILER-DAEMON Wed Jan  3 01:05:34 1996\n');
  });

  it('reads the date back, as UTC when no zone is given', () => {
    expect(parseFromLineDate('From a@b.c Wed Jan  3 01:05:34 1996').toISOString()).toBe('1996-01-03T01:05:34.000Z');
    expect(parseFromLineDate('From a@b.c Wed Jan  3 01:05:34 +0200 1996').toISOString()).toBe('1996-01-02T23:05:34.000Z');
    expect(parseFromLineDate('From a@b.c Wed Jan  3 01:05:34 1996\r').toISOString()).toBe('1996-01-03T01:05:34.000Z');
  });

  it('gives null for a line without a date', () => {
    expect(parseFromLineDate('From - ')).toBe(null);
    expect(parseFromLineDate('From a@b.c Someday')).toBe(null);
  });
});

describe('parseMbox', () => {
  const file = [
    'From a@b.c Wed Jan  3 01:05:34 1996',
    'Message-ID: <1@x>',
    'Subject: one',
    '',
    '>From the body',
    '>>From deeper',
    '',
    'From d@e.f Thu Feb 15 12:00:00 2001',
    'Message-ID: <2@x>',
    'Subject: two',
    '',
    'hello',
    '',
  ].join('\n');

  it('splits the messages, unescapes the body and drops the separating blank line', async () => {
    const msgs = await collect(Readable.from([Buffer.from(file)]));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].raw.toString()).toBe('Message-ID: <1@x>\r\nSubject: one\r\n\r\nFrom the body\r\n>From deeper\r\n');
    expect(msgs[0].fromDate.toISOString()).toBe('1996-01-03T01:05:34.000Z');
    expect(msgs[1].raw.toString()).toBe('Message-ID: <2@x>\r\nSubject: two\r\n\r\nhello\r\n');
    expect(msgs[1].fromDate.toISOString()).toBe('2001-02-15T12:00:00.000Z');
  });

  it('gives the same result however the stream is cut into chunks', async () => {
    const whole = await collect(Readable.from([Buffer.from(file)]));
    for (const size of [1, 2, 7, 64]) {
      const parts = await collect(chunked(file, size));
      expect(parts.map(m => m.raw.toString())).toEqual(whole.map(m => m.raw.toString()));
    }
  });

  it('handles CRLF files', async () => {
    const msgs = await collect(Readable.from([Buffer.from(file.replaceAll('\n', '\r\n'))]));
    expect(msgs.map(m => m.raw.toString())).toEqual([
      'Message-ID: <1@x>\r\nSubject: one\r\n\r\nFrom the body\r\n>From deeper\r\n',
      'Message-ID: <2@x>\r\nSubject: two\r\n\r\nhello\r\n',
    ]);
  });

  it('does not split on a "From " line that has no date, as an unescaped mbox body may', async () => {
    const f = 'From a@b.c Wed Jan  3 01:05:34 1996\nSubject: x\n\nFrom the desk of someone\nbye\n\n';
    const msgs = await collect(Readable.from([Buffer.from(f)]));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].raw.toString()).toContain('desk of someone');
  });

  it('keeps bytes that are not UTF-8 intact', async () => {
    const f = Buffer.concat([Buffer.from('From a@b.c Wed Jan  3 01:05:34 1996\nSubject: '), Buffer.from([0xe9, 0xff]), Buffer.from('\n\nx\n')]);
    const [m] = await collect(Readable.from([f]));
    expect(m.raw.subarray(9, 11)).toEqual(Buffer.from([0xe9, 0xff]));
  });

  it('skips a message over the size limit without buffering it, and carries on', async () => {
    const big = 'x'.repeat(300);
    const f = `From a@b.c Wed Jan  3 01:05:34 1996\nSubject: big\n\n${big}\n\nFrom a@b.c Wed Jan  3 01:05:35 1996\nSubject: ok\n\nfine\n`;
    const msgs = await collect(chunked(f, 50), { maxMessageBytes: 100 });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].raw).toBe(null);
    expect(msgs[0].tooLarge).toBe(true);
    expect(msgs[1].raw.toString()).toContain('fine');
  });

  it('refuses a file that does not start with a From line', async () => {
    await expect(collect(Readable.from([Buffer.from('Subject: not an mbox\n\nbody\n')]))).rejects.toBeInstanceOf(MailTransferFormatError);
  });

  it('yields nothing for an empty file', async () => {
    expect(await collect(Readable.from([]))).toEqual([]);
  });
});

describe('message helpers', () => {
  const raw = Buffer.from('Received: x\r\nMessage-ID:\r\n <abc@host>\r\nDate: Tue, 1 Mar 2022 10:00:00 +0100\r\nSubject: s\r\n\r\nMessage-ID: <body@x>\r\n');

  it('reads a folded Message-ID from the header only', () => {
    expect(messageIdOf(raw)).toBe('<abc@host>');
    expect(messageIdOf(Buffer.from('Subject: x\r\n\r\nMessage-ID: <b@x>'))).toBe(null);
  });

  it('prefers the From line date and falls back to the Date header', () => {
    expect(internalDateOf(raw, new Date('2020-01-01T00:00:00Z')).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(internalDateOf(raw, null).toISOString()).toBe('2022-03-01T09:00:00.000Z');
    expect(internalDateOf(Buffer.from('Subject: x\r\n\r\n'), null)).toBe(null);
    expect(internalDateOf(Buffer.from('Date: garbage\r\n\r\n'), null)).toBe(null);
  });

  it('reads a folded Subject header', () => {
    expect(subjectOf(Buffer.from('Subject: one\r\n two\r\n\r\nSubject: body'))).toBe('one two');
    expect(subjectOf(Buffer.from('X: y\r\n\r\n'))).toBe('');
  });

  it('recognises something that is not a message', () => {
    expect(looksLikeMessage(raw)).toBe(true);
    expect(looksLikeMessage(Buffer.from('just some text'))).toBe(false);
    expect(looksLikeMessage(Buffer.alloc(0))).toBe(false);
  });

  it('turns bare line feeds into CRLF and leaves CRLF alone', () => {
    expect(toCrlf(Buffer.from('a\nb\r\nc\n')).toString()).toBe('a\r\nb\r\nc\r\n');
  });
});

describe('flags in mbox headers', () => {
  it('writes Status and X-Status at the end of the header block, in the message\'s own line ends', () => {
    const crlf = Buffer.from('Subject: a\r\n\r\nStatus: in the body\r\n');
    expect(withMboxStatus(crlf, new Set(['\\Seen', '\\Answered'])).toString())
      .toBe('Subject: a\r\nStatus: RO\r\nX-Status: A\r\n\r\nStatus: in the body\r\n');
    expect(withMboxStatus(Buffer.from('Subject: a\n\nbody\n'), new Set()).toString()).toBe('Subject: a\nStatus: O\n\nbody\n');
    expect(withMboxStatus(Buffer.from('Subject: a'), new Set(['\\Flagged'])).toString()).toBe('Subject: a\nStatus: O\nX-Status: F\n');
  });

  it('leaves a message that already has a Status header as it is', () => {
    const raw = Buffer.from('Status: O\r\nSubject: a\r\n\r\nb\r\n');
    expect(withMboxStatus(raw, new Set(['\\Seen']))).toBe(raw);
  });

  it('reads the flags back, from the header block only', () => {
    expect(mboxFlagsOf(Buffer.from('Subject: a\r\nStatus: RO\r\nX-Status: AF\r\n\r\nb'))).toEqual(['\\Seen', '\\Answered', '\\Flagged']);
    expect(mboxFlagsOf(Buffer.from('X-Mozilla-Status: 0003\r\n\r\nb'))).toEqual(['\\Seen', '\\Answered']);
    expect(mboxFlagsOf(Buffer.from('Subject: a\r\n\r\nStatus: RO\r\n'))).toBeNull();
  });
});
