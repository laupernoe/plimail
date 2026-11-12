// A hostile calendar must not hold the process: ical.js can loop forever inside one next(), which no
// test timeout interrupts, so those cases run in a worker that is terminated if it does not answer.
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { eventLoopYielder, expandResource, expandResourceAsync, resourceInfo } from './icalEvents.js';

const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
const series = (rule, start = 'DTSTART:20000101T090000Z') => cal('BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', start, 'DURATION:PT1H', `RRULE:${rule}`, 'END:VEVENT');
const range = (from, to) => [Date.parse(from), Date.parse(to)];

function inWorker(fn, ics, timeoutMs = 15000) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then((m) => {
      const started = Date.now();
      let outcome;
      try { outcome = { value: JSON.stringify(m[workerData.fn](workerData.ics, ...workerData.args)) }; }
      catch (err) { outcome = { error: err.message }; }
      parentPort.postMessage({ ...outcome, ms: Date.now() - started });
    });`;
  const args = fn === 'expandResource' ? range('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z') : [];
  const worker = new Worker(source, { eval: true, workerData: { module: new URL('./icalEvents.js', import.meta.url).href, fn, ics, args } });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { worker.terminate(); resolve({ hung: true }); }, timeoutMs);
    worker.once('message', (msg) => { clearTimeout(timer); worker.terminate(); resolve(msg); });
    worker.once('error', (err) => { clearTimeout(timer); resolve({ error: err.message }); });
  });
}

describe('a rule ical.js cannot satisfy', () => {
  // DAILY with BYMONTH=2;BYMONTHDAY=30 never matches, and ical.js has no bound on that search.
  const impossible = series('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;COUNT=3');

  it('fails to expand instead of hanging', async () => {
    const out = await inWorker('expandResource', impossible);
    expect(out.hung).toBeUndefined();
    expect(out.error).toMatch(/too costly/);
  }, 30000);

  it('still gets a resourceInfo, as an open-ended series', async () => {
    const out = await inWorker('resourceInfo', impossible);
    expect(out.hung).toBeUndefined();
    expect(JSON.parse(out.value).rangeEnd).toBeNull();
  }, 30000);
});

describe('a time zone defined by a rule that walks every second since 1601', () => {
  const zone = [
    'BEGIN:VTIMEZONE', 'TZID:Hostile', 'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100',
    'RRULE:FREQ=SECONDLY', 'END:STANDARD', 'END:VTIMEZONE',
  ];
  const ics = cal(...zone, 'BEGIN:VEVENT', 'UID:z', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Hostile:20260301T090000', 'DURATION:PT1H', 'END:VEVENT');

  it('is refused quickly when the event is read, instead of holding the process', async () => {
    for (const fn of ['resourceInfo', 'expandResource']) {
      const out = await inWorker(fn, ics);
      expect(out.hung).toBeUndefined();
      expect(out.error).toMatch(/too costly/);
    }
  }, 60000);
});

describe('resourceInfo', () => {
  it('reads the end of a long series from its UNTIL instead of walking it', () => {
    const info = resourceInfo(series('FREQ=DAILY;UNTIL=20991231T090000Z'));
    expect(info.rangeEnd.toISOString().slice(0, 10)).toBe('2100-01-01');
  });

  it('leaves a long COUNT open rather than walking it', () => {
    expect(resourceInfo(series('FREQ=DAILY;COUNT=5000')).rangeEnd).toBeNull();
  });
});

describe('expandResourceAsync', () => {
  it('gives the event loop back during a long series and finds what expandResource finds', async () => {
    // ical.js takes about half a millisecond per daily occurrence, so a series of a few years is enough.
    const ics = series('FREQ=DAILY', 'DTSTART:20230101T090000Z');
    const window = range('2026-03-01T00:00:00Z', '2026-03-08T00:00:00Z');
    let turns = 0;
    const tick = setInterval(() => { turns++; }, 0);
    try {
      const occ = await expandResourceAsync(ics, ...window, {}, eventLoopYielder(1));
      expect(turns).toBeGreaterThan(0);
      expect(occ).toEqual(expandResource(ics, ...window));
      expect(occ).toHaveLength(7);
    } finally {
      clearInterval(tick);
    }
  });

  it('stops at the limit', () => {
    expect(expandResource(series('FREQ=DAILY'), 0, 8.64e15, { limit: 1 })).toHaveLength(1);
  });
});
