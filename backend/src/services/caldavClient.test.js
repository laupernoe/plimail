import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_EVENT_DATA_BYTES, MAX_RESPONSE_BYTES, bindCredentials, calendarGone, deleteEvent, digestHeader, discoverCalendars, fetchEvents, findCalDavServer,
  forgetAuthSchemes, hrefKey, listCalendars, listEvents, moveEvent, parseAddresses, parseCalendars, parseHref, parseResources, putEvent,
} from './caldavClient.js';

const BASE = 'https://dav.example.com/cal/noe/';

describe('parseCalendars', () => {
  const xml = (props, href = '/cal/noe/perso/') => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/">
    <d:response><d:href>/cal/noe/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    <d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  </d:multistatus>`;
  const CAL = '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>';

  it('reads a calendar and normalizes an 8-digit color', () => {
    const [c] = parseCalendars(xml(`${CAL}<d:displayname>Perso</d:displayname><a:calendar-color>#FF8800FF</a:calendar-color><cs:getctag>abc</cs:getctag>`), BASE);
    expect(c).toEqual({ url: 'https://dav.example.com/cal/noe/perso/', name: 'Perso', color: '#ff8800', ctag: 'abc', readOnly: false });
  });

  it('skips a task-only calendar', () => {
    expect(parseCalendars(xml(`${CAL}<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>`), BASE)).toEqual([]);
  });

  it('marks a calendar without a write privilege read-only', () => {
    const ro = '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>';
    expect(parseCalendars(xml(`${CAL}${ro}`), BASE)[0].readOnly).toBe(true);
    const rw = '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>';
    expect(parseCalendars(xml(`${CAL}${rw}`), BASE)[0].readOnly).toBe(false);
  });

  it('falls back to the collection name for a calendar with no display name', () => {
    expect(parseCalendars(xml(CAL, '/cal/noe/my%20work/'), BASE)[0].name).toBe('my work');
  });
});

describe('parseResources', () => {
  it('skips the collection itself and decodes numeric references', () => {
    const out = parseResources(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:response><d:href>/cal/noe/perso/</d:href><d:propstat><d:prop><d:getetag>"c"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/cal/noe/perso/a.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data>BEGIN:VCALENDAR&#13;
END:VCALENDAR</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>`, `${BASE}perso/`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rawHref: '/cal/noe/perso/a.ics', url: 'https://dav.example.com/cal/noe/perso/a.ics', etag: '"1"' });
    expect(out[0].ical).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR');
  });

  it('throws on a truncated answer rather than reading it as deletions', () => {
    expect(() => parseResources('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response></d:multistatus>', BASE))
      .toThrow(/truncated/);
  });
});

describe('parseHref', () => {
  it('takes the first of several hrefs', () => {
    expect(parseHref(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/a/</d:href><d:href>/b/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, 'calendar-home-set', BASE))
      .toBe('https://dav.example.com/a/');
  });
});

describe('digestHeader', () => {
  it('matches the worked example of RFC 2617', () => {
    const header = digestHeader('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"', {
      username: 'Mufasa', password: 'Circle Of Life', method: 'GET', url: 'http://www.nowhere.org/dir/index.html', cnonce: '0a4f113b',
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });
  it('returns null for a challenge that is not Digest', () => {
    expect(digestHeader('Basic realm="x"', { username: 'a', password: 'b', method: 'GET', url: 'http://x/' })).toBeNull();
  });
});

describe('hrefKey', () => {
  it('treats two spellings of one href as the same', () => {
    expect(hrefKey('https://a.example/c/x%40y.ics')).toBe(hrefKey('https://a.example/c/x@y.ics'));
    expect(hrefKey('https://a.example/c/%7Bid%7D.ics')).toBe(hrefKey('https://a.example/c/{id}.ics'));
  });
});

describe('against a server', () => {
  let servers = [];
  afterEach(() => {
    for (const s of servers) { s.closeAllConnections(); s.close(); }
    servers = [];
    forgetAuthSchemes();
    vi.restoreAllMocks();
  });
  const multi = inner => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`;
  const prop = (href, inner) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${inner}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const BASIC = `Basic ${Buffer.from('u:p').toString('base64')}`;
  const start = handler => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.connections = 0;
    server.on('connection', () => { server.connections++; });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const serverAt = base => servers.find(s => base.endsWith(`:${s.address().port}`));
  // Over plaintext nothing goes out before a challenge, so a test server asks for Basic.
  const requireBasic = (req, res) => {
    if (req.headers.authorization === BASIC) return false;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
    res.end();
    return true;
  };
  const calendarAnswer = (res, url, body, { home = '/h/', calendar = '/h/work/' } = {}) => {
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    if (body.includes('current-user-principal')) res.end(multi(prop(url, '<d:current-user-principal><d:href>/p/</d:href></d:current-user-principal>')));
    else if (body.includes('calendar-home-set')) res.end(multi(prop(url, `<c:calendar-home-set><d:href>${home}</d:href></c:calendar-home-set>`)));
    else res.end(multi(prop(calendar, '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work</d:displayname>')));
  };
  const discover = base => discoverCalendars({ serverUrl: `${base}/`, username: 'u', password: 'p', allowPrivate: true });
  const bound = base => bindCredentials(`${base}/`, { username: 'u', password: 'p', allowPrivate: true });

  it('answers a Digest challenge without ever sending the password as Basic', async () => {
    const auths = [];
    const base = await start((req, res, body) => {
      auths.push(req.headers.authorization || null);
      if (!/^Digest /.test(req.headers.authorization || '')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="r", qop="auth", nonce="n1"' });
        return res.end();
      }
      const a = Object.fromEntries([...req.headers.authorization.matchAll(/(\w+)="?([^",]+)"?/g)].map(m => [m[1], m[2]]));
      const md5 = s => crypto.createHash('md5').update(s).digest('hex');
      const good = md5(`${md5('u:r:p')}:n1:${a.nc}:${a.cnonce}:auth:${md5(`${req.method}:${req.url}`)}`);
      if (a.response !== good) { res.writeHead(401); return res.end(); }
      calendarAnswer(res, req.url, body);
    });
    const cals = await discover(base);
    expect(cals.map(c => c.name)).toEqual(['Work']);
    expect(auths.some(h => /^Basic /i.test(h || ''))).toBe(false);
  });

  it('keeps the verb and the credentials through a redirect on the same origin', async () => {
    const seen = [];
    const base = await start((req, res, body) => {
      seen.push([req.method, req.url, req.headers.authorization]);
      if (requireBasic(req, res)) return;
      if (req.url === '/.well-known/caldav') { res.writeHead(301, { Location: '/dav/' }); return res.end(); }
      if (req.url === '/') { res.writeHead(404); return res.end(); }
      calendarAnswer(res, req.url, body);
    });
    const cals = await discover(base);
    expect(cals).toHaveLength(1);
    expect(seen.find(s => s[1] === '/dav/' && s[2])).toEqual(['PROPFIND', '/dav/', BASIC]);
  });

  it('does not follow a redirect to another origin, and names it', async () => {
    const other = await start((req, res) => { res.writeHead(500); res.end(); });
    const base = await start((req, res) => {
      if (requireBasic(req, res)) return;
      res.writeHead(301, { Location: `${other}/dav/` });
      res.end();
    });
    const err = await discover(base).catch(e => e);
    expect(err.message).toContain(`${other}/dav/`);
    expect(err.message).toMatch(/enter it as the server URL/);
    expect(serverAt(other).connections).toBe(0);
  });

  it('does not send the password to a calendar home on another origin', async () => {
    const other = await start((req, res, body) => calendarAnswer(res, req.url, body));
    const base = await start((req, res, body) => {
      if (requireBasic(req, res)) return;
      calendarAnswer(res, req.url, body, { home: `${other}/h/` });
    });
    await expect(discover(base)).rejects.toThrow(`${other}/h/`);
    expect(serverAt(other).connections).toBe(0);
  });

  it('leaves out a calendar listed on another origin', async () => {
    const other = await start((req, res, body) => calendarAnswer(res, req.url, body));
    const base = await start((req, res, body) => {
      if (requireBasic(req, res)) return;
      calendarAnswer(res, req.url, body, { calendar: `${other}/h/work/` });
    });
    await expect(discover(base)).rejects.toThrow(`${other}/h/work/`);
    const listed = await listCalendars(`${base}/h/`, bound(base));
    expect(listed.calendars).toEqual([]);
    expect(listed.elsewhere.map(c => c.url)).toEqual([`${other}/h/work/`]);
    expect(serverAt(other).connections).toBe(0);
  });

  it('does not try an SRV target on another origin, and names it when nothing else answers', async () => {
    const other = await start((req, res, body) => calendarAnswer(res, req.url, body));
    const { port } = serverAt(other).address();
    vi.spyOn(dns, 'resolveSrv').mockResolvedValue([{ name: '127.0.0.1', port, priority: 0, weight: 0 }]);
    vi.spyOn(dns, 'resolveTxt').mockResolvedValue([['path=/dav/']]);
    const base = await start((req, res) => {
      if (requireBasic(req, res)) return;
      res.writeHead(404);
      res.end();
    });
    await expect(discover(base)).rejects.toThrow(`https://127.0.0.1:${port}/dav/`);
    expect(serverAt(other).connections).toBe(0);
  });

  it('refuses an answer past the size cap, declared or streamed', async () => {
    const declared = await start((req, res) => {
      if (requireBasic(req, res)) return;
      res.writeHead(207, { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) });
      res.flushHeaders();
    });
    await expect(discover(declared)).rejects.toThrow(/more than 10 MB/);
    const chunk = Buffer.alloc(1024 * 1024, 'a');
    const endless = 4 * MAX_RESPONSE_BYTES;
    let written = 0;
    const streamed = await start((req, res) => {
      if (requireBasic(req, res)) return;
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      const pump = () => {
        while (written < endless && res.write(chunk)) written += chunk.length;
        if (written < endless) res.once('drain', pump);
        else res.end();
      };
      res.on('close', () => res.off('drain', pump));
      pump();
    });
    await expect(discover(streamed)).rejects.toThrow(/more than 10 MB/);
    expect(written).toBeLessThan(endless);
  });

  it('splits a multiget over the cap, and reports one event over it without losing the others', async () => {
    const event = uid => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20260101T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const base = await start((req, res, body) => {
      if (requireBasic(req, res)) return;
      const hrefs = [...body.matchAll(/<href>([^<]+)<\/href>/g)].map(m => m[1]);
      if (hrefs.length > 1 || hrefs[0] === '/h/work/big.ics') {
        res.writeHead(207, { 'Content-Length': String(MAX_EVENT_DATA_BYTES + 1) });
        return res.flushHeaders();
      }
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(multi(prop(hrefs[0], `<d:getetag>"1"</d:getetag><c:calendar-data>${event(hrefs[0])}</c:calendar-data>`)));
    });
    const out = await fetchEvents(`${base}/h/work/`, ['/h/work/a.ics', '/h/work/big.ics', '/h/work/c.ics'], bound(base));
    expect(out.filter(e => e.ical).map(e => e.rawHref)).toEqual(['/h/work/a.ics', '/h/work/c.ics']);
    expect(out.find(e => e.rawHref === '/h/work/big.ics').error).toMatch(/larger than 25 MB/);
  });

  // 192.0.2.1 is TEST-NET-1: public to the classifier, never routed, and refused before any connect.
  it('refuses plaintext HTTP to a public address even with private hosts allowed', async () => {
    await expect(discoverCalendars({ serverUrl: 'http://192.0.2.1/', username: 'u', password: 'p', allowPrivate: true }))
      .rejects.toThrow(/Plaintext HTTP is not allowed/);
  });

  it('stops at the first refusal of the credentials', async () => {
    let hits = 0;
    const base = await start((req, res) => { hits++; res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); res.end(); });
    await expect(discoverCalendars({ serverUrl: `${base}/`, username: 'u', password: 'bad', allowPrivate: true })).rejects.toThrow(/Authentication failed/);
    // The challenge, then the one answer to it.
    expect(hits).toBe(2);
  });

  it('finds calendars on a server with no principal support', async () => {
    const base = await start((req, res, body) => {
      if (requireBasic(req, res)) return;
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      if (body.includes('current-user-principal') || body.includes('calendar-home-set')) return res.end(multi(prop(req.url, '<d:displayname>root</d:displayname>')));
      res.end(multi(prop('/cal/', '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>')));
    });
    expect(await discover(base)).toHaveLength(1);
  });

  it('offers credentials only to the hosts it is given', async () => {
    await expect(findCalDavServer([null, undefined], { username: 'u', password: 'p' })).rejects.toThrow(/No CalDAV server/);
  });

  it('reads relative hrefs against the URL an answer came from after a redirect', async () => {
    const base = await start((req, res) => {
      if (requireBasic(req, res)) return;
      if (req.url === '/old/work/') { res.writeHead(301, { Location: '/new/work/' }); return res.end(); }
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(multi(prop('a.ics', '<d:getetag>"1"</d:getetag>')));
    });
    const [ev] = await listEvents(`${base}/old/work/`, bound(base));
    expect(ev.url).toBe(`${base}/new/work/a.ics`);
  });

  it('tells a calendar that is gone from one that only failed to answer', async () => {
    const base = await start((req, res) => {
      if (requireBasic(req, res)) return;
      if (req.url === '/gone/') { res.writeHead(404); return res.end(); }
      if (req.url === '/broken/') { res.writeHead(500); return res.end(); }
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(multi(prop(req.url, '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>')));
    });
    const creds = bound(base);
    expect(await calendarGone(`${base}/gone/`, creds)).toBe(true);
    expect(await calendarGone(`${base}/here/`, creds)).toBe(false);
    await expect(calendarGone(`${base}/broken/`, creds)).rejects.toThrow(/500/);
  });

  it('never replaces or deletes an event without the version it was read at', async () => {
    const base = await start((req, res) => { res.writeHead(204); res.end(); });
    const creds = bound(base);
    await expect(putEvent(`${base}/h/a.ics`, 'BEGIN:VCALENDAR', creds, { etag: null })).rejects.toThrow(/version of this event/);
    await expect(deleteEvent(`${base}/h/a.ics`, creds, { etag: null })).rejects.toThrow(/version of this event/);
    await expect(moveEvent(`${base}/h/a.ics`, `${base}/k/a.ics`, creds, {})).rejects.toThrow(/version of this event/);
    expect(serverAt(base).connections).toBe(0);
  });

  it('moves an event with one MOVE that names its version and replaces nothing', async () => {
    const seen = [];
    const base = await start((req, res) => {
      if (requireBasic(req, res)) return;
      seen.push({ method: req.method, url: req.url, destination: req.headers.destination, overwrite: req.headers.overwrite, ifMatch: req.headers['if-match'] });
      res.writeHead(201);
      res.end();
    });
    const out = await moveEvent(`${base}/h/work/a.ics`, `${base}/h/home/a.ics`, bound(base), { etag: '"7"' });
    expect(out.url).toBe(`${base}/h/home/a.ics`);
    expect(seen).toEqual([{ method: 'MOVE', url: '/h/work/a.ics', destination: `${base}/h/home/a.ics`, overwrite: 'F', ifMatch: '"7"' }]);
  });

  it('does not move an event to another origin', async () => {
    const other = await start((req, res) => { res.writeHead(201); res.end(); });
    const base = await start((req, res) => { res.writeHead(201); res.end(); });
    await expect(moveEvent(`${base}/h/a.ics`, `${other}/h/a.ics`, bound(base), { etag: '"1"' })).rejects.toThrow(`${other}/h/a.ics`);
    expect(serverAt(base).connections + serverAt(other).connections).toBe(0);
  });

  it('refuses a request whose credentials are bound to no origin', async () => {
    const base = await start((req, res) => { res.writeHead(500); res.end(); });
    await expect(fetchEvents(`${base}/h/`, ['/h/a.ics'], { username: 'u', password: 'p', allowPrivate: true })).rejects.toThrow(/not on/);
    expect(serverAt(base).connections).toBe(0);
  });
});

describe('parseAddresses', () => {
  it('keeps the mailto addresses, lowercased, once each', () => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/p/noe/</D:href><D:propstat><D:prop>
      <C:calendar-user-address-set><D:href>mailto:Noe@Example.com</D:href><D:href>/p/noe/</D:href><D:href>MAILTO:noe@example.com</D:href><D:href>mailto:n%2Bcal@example.com</D:href></C:calendar-user-address-set>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    expect(parseAddresses(xml)).toEqual(['noe@example.com', 'n+cal@example.com']);
  });
});
