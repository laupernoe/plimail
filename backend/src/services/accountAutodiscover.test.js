import { describe, expect, it, vi } from 'vitest';
import {
  AUTOCONFIG_MAX_BYTES, acceptServer, discoverAccountSettings, mxBaseDomain, oauthFor, parseAutoconfig, sortSrv, splitAddress,
} from './accountAutodiscover.js';

const POLICY = { allowPrivate: false, allowNonstandardPorts: false };

const xml = ({ imap = '', smtp = '', extra = '' } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <domain>example.org</domain>
    ${imap}
    ${smtp}
  </emailProvider>
  ${extra}
</clientConfig>`;
const server = (dir, type, { host, port, socket, user = '%EMAILADDRESS%', auth = ['password-cleartext'] }) => `
  <${dir} type="${type}">
    <hostname>${host}</hostname><port>${port}</port><socketType>${socket}</socketType>
    <username>${user}</username>${auth.map(a => `<authentication>${a}</authentication>`).join('')}
  </${dir}>`;
const imap = o => server('incomingServer', 'imap', o);
const pop = o => server('incomingServer', 'pop3', o);
const smtp = o => server('outgoingServer', 'smtp', o);

const STANDARD = xml({
  imap: imap({ host: 'imap.example.org', port: 993, socket: 'SSL' }),
  smtp: smtp({ host: 'smtp.example.org', port: 587, socket: 'STARTTLS' }),
});

// A response as fetch gives it, with a body the reader can iterate.
function response(status, text, headers = {}) {
  const bytes = Buffer.from(text);
  return {
    status,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    body: {
      async *[Symbol.asyncIterator]() { yield bytes; },
      cancel: async () => {},
    },
  };
}

// fetch answering by URL; anything not listed fails like an unreachable host.
function fetchFrom(map) {
  return vi.fn(async (url) => {
    const answer = map[url];
    if (!answer) throw new TypeError('fetch failed');
    return typeof answer === 'function' ? answer() : response(200, answer);
  });
}

// A resolver answering from tables; a name not listed is NXDOMAIN.
function resolverFrom({ srv = {}, mx = {}, a = {}, txt = {} } = {}) {
  const nx = () => Promise.reject(Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' }));
  const from = table => vi.fn(name => (name in table ? Promise.resolve(table[name]) : nx()));
  return {
    resolveSrv: from(srv), resolveMx: from(mx), resolveTxt: from(txt), resolve4: from(a), resolve6: vi.fn(nx),
  };
}

describe('splitAddress', () => {
  it('reads the local part and the ASCII domain', () => {
    expect(splitAddress(' Jane.Doe@Exämple.org ')).toEqual({ local: 'Jane.Doe', domain: 'xn--exmple-cua.org', address: 'Jane.Doe@xn--exmple-cua.org' });
  });
  it.each(['', 'nobody', '@example.org', 'a@localhost', 'a@127.0.0.1', 'a b@example.org', 'a@exa mple.org', 5, null])('refuses %j', (v) => {
    expect(splitAddress(v)).toBeNull();
  });
});

describe('parseAutoconfig', () => {
  it('reads the servers in order and fills in the placeholders', () => {
    const doc = xml({
      imap: imap({ host: 'imap.%EMAILDOMAIN%', port: 993, socket: 'SSL', user: '%EMAILLOCALPART%' })
        + imap({ host: 'imap2.example.org', port: 143, socket: 'STARTTLS' }),
      smtp: smtp({ host: 'smtp.example.org', port: 465, socket: 'SSL' }),
    });
    expect(parseAutoconfig(doc, 'jane@example.org')).toEqual({
      imap: [
        { host: 'imap.example.org', port: 993, tls: 'SSL', username: 'jane' },
        { host: 'imap2.example.org', port: 143, tls: 'STARTTLS', username: 'jane@example.org' },
      ],
      smtp: [{ host: 'smtp.example.org', port: 465, tls: 'SSL', username: 'jane@example.org' }],
      caldavUrl: null,
    });
  });

  it('leaves out POP3 and servers that only take OAuth', () => {
    const doc = xml({
      imap: pop({ host: 'pop.example.org', port: 995, socket: 'SSL' })
        + imap({ host: 'oauth.example.org', port: 993, socket: 'SSL', auth: ['OAuth2'] })
        + imap({ host: 'imap.example.org', port: 993, socket: 'SSL', auth: ['OAuth2', 'password-cleartext'] }),
    });
    expect(parseAutoconfig(doc, 'a@example.org').imap.map(s => s.host)).toEqual(['imap.example.org']);
  });

  it('reads a CalDAV server beside the mail servers', () => {
    const doc = xml({
      imap: imap({ host: 'imap.example.org', port: 993, socket: 'SSL' }),
      extra: '<calendar type="caldav"><serverURL>https://dav.example.org/%EMAILADDRESS%/</serverURL></calendar>',
    });
    expect(parseAutoconfig(doc, 'a@example.org').caldavUrl).toBe('https://dav.example.org/a@example.org/');
  });

  it.each(['', 'not xml', '<html><body>404</body></html>', '<clientConfig/>'])('gives nothing for %j', (doc) => {
    expect(parseAutoconfig(doc, 'a@example.org')).toBeNull();
  });

  it('does not expand entities', () => {
    const doc = `<?xml version="1.0"?><!DOCTYPE c [<!ENTITY x "evil.example">]>${STANDARD.replace('imap.example.org', '&x;')}`;
    const parsed = parseAutoconfig(doc, 'a@example.org');
    expect(parsed?.imap[0]?.host).not.toBe('evil.example');
  });
});

describe('acceptServer', () => {
  it('takes TLS servers on the allowed ports', () => {
    expect(acceptServer('imap', { host: 'IMAP.Example.org.', port: 993, tls: 'SSL' }, POLICY)).toEqual({ host: 'imap.example.org', port: 993, tls: 'SSL' });
    expect(acceptServer('imap', { host: 'imap.example.org', port: 143, tls: 'STARTTLS' }, POLICY)).not.toBeNull();
    expect(acceptServer('smtp', { host: 'smtp.example.org', port: 465, tls: 'SSL' }, POLICY)).not.toBeNull();
  });
  it.each([
    ['imap', { host: 'imap.example.org', port: 143, tls: 'plain' }],
    ['imap', { host: 'imap.example.org', port: 993, tls: 'STARTTLS' }],
    ['imap', { host: 'imap.example.org', port: 143, tls: 'SSL' }],
    ['imap', { host: 'imap.example.org', port: 1143, tls: 'STARTTLS' }],
    ['smtp', { host: 'smtp.example.org', port: 25, tls: 'STARTTLS' }],
    ['imap', { host: 'localhost', port: 993, tls: 'SSL' }],
    ['imap', { host: '10.0.0.1', port: 993, tls: 'SSL' }],
    ['imap', { host: 'mail.internal', port: 993, tls: 'SSL' }],
    ['imap', { host: 'bad host', port: 993, tls: 'SSL' }],
  ])('refuses %s %j', (kind, s) => {
    expect(acceptServer(kind, s, POLICY)).toBeNull();
  });
  it('takes other ports and private names when the instance allows them', () => {
    const open = { allowPrivate: true, allowNonstandardPorts: true };
    expect(acceptServer('imap', { host: 'mail.internal', port: 1143, tls: 'STARTTLS' }, open)).not.toBeNull();
    expect(acceptServer('smtp', { host: 'smtp.example.org', port: 2525, tls: 'STARTTLS' }, open)).not.toBeNull();
  });
});

describe('sortSrv', () => {
  it('orders by priority, then by weight, and drops "."', () => {
    const sorted = sortSrv([
      { name: 'c.example.org', port: 993, priority: 10, weight: 0 },
      { name: '.', port: 0, priority: 0, weight: 0 },
      { name: 'b.example.org', port: 993, priority: 5, weight: 10 },
      { name: 'a.example.org', port: 993, priority: 5, weight: 50 },
    ]);
    expect(sorted.map(r => r.name)).toEqual(['a.example.org', 'b.example.org', 'c.example.org']);
  });
});

describe('mxBaseDomain', () => {
  it.each([
    ['mx2ff3.netcup.net', 'netcup.net'],
    ['mx01.mail.example.co.uk.', 'example.co.uk'],
    ['mx.example.de', 'example.de'],
    ['example', null],
  ])('%s is %s', (host, base) => expect(mxBaseDomain(host)).toBe(base));
});

describe('oauthFor', () => {
  it('names the sign-in of Gmail and Microsoft hosts only', () => {
    expect(oauthFor('imap.gmail.com')).toBe('google');
    expect(oauthFor('outlook.office365.com')).toBe('microsoft');
    expect(oauthFor('imap.example.org')).toBeNull();
  });
});

describe('discoverAccountSettings', () => {
  const run = (email, { fetch = fetchFrom({}), resolver = resolverFrom(), policy = POLICY } = {}) =>
    discoverAccountSettings(email, { ...policy, fetchImpl: fetch, resolver });

  it('uses the ISPDB when the domain publishes nothing, asking it about the domain only', async () => {
    const fetch = fetchFrom({
      'https://autoconfig.thunderbird.net/v1.1/example.org': STANDARD,
    });
    const r = await run('jane@example.org', { fetch });
    expect(r).toMatchObject({
      source: 'ispdb', domain: 'example.org', username: 'jane@example.org', oauth: null,
      imap: { host: 'imap.example.org', port: 993, tls: 'SSL' }, smtp: { host: 'smtp.example.org', port: 587, tls: 'STARTTLS' },
    });
    for (const [url, , policy] of fetch.mock.calls) {
      expect(url).not.toContain('jane');
      expect(url.startsWith('https://')).toBe(true);
      expect(policy).toMatchObject({ requireHttps: true, allowPrivate: false });
    }
  });

  it('falls back to the domain\'s own autoconfig, then the well-known one', async () => {
    const own = await run('a@example.org', { fetch: fetchFrom({ 'https://autoconfig.example.org/mail/config-v1.1.xml': STANDARD }) });
    expect(own.source).toBe('autoconfig');
    const wellKnown = await run('a@example.org', { fetch: fetchFrom({ 'https://example.org/.well-known/autoconfig/mail/config-v1.1.xml': STANDARD }) });
    expect(wellKnown.source).toBe('wellknown');
  });

  it('skips a document that answers with an error, a huge body, or servers it cannot use', async () => {
    const fetch = fetchFrom({
      'https://autoconfig.thunderbird.net/v1.1/example.org': () => response(404, STANDARD),
      'https://autoconfig.example.org/mail/config-v1.1.xml': () => response(200, STANDARD, { 'content-length': String(AUTOCONFIG_MAX_BYTES + 1) }),
      'https://example.org/.well-known/autoconfig/mail/config-v1.1.xml': xml({ imap: imap({ host: 'imap.example.org', port: 143, socket: 'plain' }) }),
    });
    const r = await run('a@example.org', { fetch, resolver: resolverFrom({ a: { 'imap.example.org': ['203.0.113.5'] } }) });
    expect(r.source).toBe('guess');
  });

  it("prefers the domain's own autoconfig over the ISPDB", async () => {
    const fetch = fetchFrom({
      'https://autoconfig.thunderbird.net/v1.1/example.org': xml({ imap: imap({ host: 'imap.isp.example', port: 993, socket: 'SSL' }) }),
      'https://autoconfig.example.org/mail/config-v1.1.xml': STANDARD,
    });
    const r = await run('a@example.org', { fetch });
    expect(r.source).toBe('autoconfig');
  });

  it('stops reading a body past the size cap', async () => {
    const big = STANDARD + ' '.repeat(AUTOCONFIG_MAX_BYTES);
    const r = await run('a@example.org', { fetch: fetchFrom({ 'https://autoconfig.thunderbird.net/v1.1/example.org': big }) });
    expect(r.source).toBe('guess');
  });

  it('uses SRV records, implicit TLS first, in SRV order', async () => {
    const resolver = resolverFrom({ srv: {
      '_imap._tcp.example.org': [{ name: 'starttls.example.org', port: 143, priority: 0, weight: 0 }],
      '_imaps._tcp.example.org': [
        { name: 'imap2.example.org', port: 993, priority: 10, weight: 0 },
        { name: 'imap1.example.org', port: 993, priority: 0, weight: 0 },
      ],
      '_submission._tcp.example.org': [{ name: 'smtp.example.org', port: 587, priority: 0, weight: 0 }],
    } });
    const r = await run('a@example.org', { resolver });
    expect(r).toMatchObject({ source: 'srv', imap: { host: 'imap1.example.org', port: 993, tls: 'SSL' }, smtp: { host: 'smtp.example.org', port: 587, tls: 'STARTTLS' } });
  });

  it('gives Google\'s servers and sign-in to a domain whose mail Google takes', async () => {
    const resolver = resolverFrom({ mx: { 'example.org': [{ exchange: 'alt1.aspmx.l.google.com', priority: 5 }, { exchange: 'mx.example.org', priority: 10 }] } });
    const r = await run('a@example.org', { resolver });
    expect(r).toMatchObject({ source: 'mx', oauth: 'google', imap: { host: 'imap.gmail.com' }, caldavUrl: null });
  });

  it('gives Microsoft 365\'s servers and sign-in to a domain whose mail it takes', async () => {
    const resolver = resolverFrom({ mx: { 'example.org': [{ exchange: 'example-org.mail.protection.outlook.com', priority: 0 }] } });
    expect(await run('a@example.org', { resolver })).toMatchObject({ source: 'mx', oauth: 'microsoft', imap: { host: 'outlook.office365.com' } });
  });

  it('asks the ISPDB about the provider behind the MX', async () => {
    const resolver = resolverFrom({ mx: { 'example.org': [{ exchange: 'mx2ff3.netcup.net', priority: 0 }] } });
    const fetch = fetchFrom({
      'https://autoconfig.thunderbird.net/v1.1/netcup.net': xml({
        imap: imap({ host: 'mx2ff3.netcup.net', port: 993, socket: 'SSL' }),
        smtp: smtp({ host: 'mx2ff3.netcup.net', port: 465, socket: 'SSL' }),
      }),
    });
    const r = await run('a@example.org', { fetch, resolver });
    expect(r).toMatchObject({ source: 'mx-ispdb', imap: { host: 'mx2ff3.netcup.net' }, smtp: { port: 465, tls: 'SSL' } });
  });

  it('guesses the usual names last, preferring one that resolves', async () => {
    const resolver = resolverFrom({ a: { 'mail.example.org': ['203.0.113.5'] } });
    const r = await run('a@example.org', { resolver });
    expect(r).toMatchObject({
      source: 'guess', imap: { host: 'mail.example.org', port: 993, tls: 'SSL' }, smtp: { host: 'mail.example.org', port: 587, tls: 'STARTTLS' },
    });
    const none = await run('a@example.org');
    expect(none.imap.host).toBe('imap.example.org');
    expect(none.smtp.host).toBe('smtp.example.org');
  });

  it('fills a missing SMTP server with a guess', async () => {
    const fetch = fetchFrom({ 'https://autoconfig.thunderbird.net/v1.1/example.org': xml({ imap: imap({ host: 'imap.example.org', port: 993, socket: 'SSL' }) }) });
    const r = await run('a@example.org', { fetch });
    expect(r).toMatchObject({ source: 'ispdb', smtp: { host: 'smtp.example.org', port: 587 } });
  });

  it('keeps a different SMTP login and the CalDAV server from DNS', async () => {
    const fetch = fetchFrom({ 'https://autoconfig.thunderbird.net/v1.1/example.org': xml({
      imap: imap({ host: 'imap.example.org', port: 993, socket: 'SSL', user: '%EMAILLOCALPART%' }),
      smtp: smtp({ host: 'smtp.example.org', port: 587, socket: 'STARTTLS' }),
    }) });
    const resolver = resolverFrom({
      srv: { '_caldavs._tcp.example.org': [{ name: 'dav.example.org', port: 8443, priority: 0, weight: 0 }] },
      txt: { '_caldavs._tcp.example.org': [['path=/cal/']] },
    });
    const r = await run('jane@example.org', { fetch, resolver });
    expect(r).toMatchObject({ username: 'jane', smtpUsername: 'jane@example.org', caldavUrl: 'https://dav.example.org:8443/cal/' });
  });

  it('gives nothing for what is not an address', async () => {
    const fetch = fetchFrom({});
    expect(await run('not-an-address', { fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
