import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getAiStatus: vi.fn(),
  completeText: vi.fn(),
  consume: vi.fn(),
  fetchMessageBody: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../services/aiProvider.js', () => ({
  getAdminAiConfig: vi.fn(),
  getAiNewUsersEnabled: vi.fn(),
  saveAiConfig: vi.fn(),
  deleteAiConfig: vi.fn(),
  listOpenRouterModels: vi.fn(),
  testAiProvider: vi.fn(),
  streamChat: vi.fn(),
  getAiStatus: mocks.getAiStatus,
  completeText: mocks.completeText,
}));
vi.mock('../services/openaiCodexAuth.js', () => ({
  startDeviceFlow: vi.fn(),
  pollDeviceFlow: vi.fn(),
  cancelDeviceFlow: vi.fn(),
  getCodexStatus: vi.fn(),
  disconnectCodex: vi.fn(),
}));
vi.mock('../services/rateLimiter.js', () => ({ consume: mocks.consume }));

import express from 'express';
import writingStyleRoutes from './aiWritingStyle.js';

const USER = 'user-1';
const ACCOUNT = { id: 'acct-1', user_id: USER, enabled: true };
const UPDATED = '2026-11-14T10:00:00.000Z';

let server;
let base;
let user;
let sentRows;
let aiEnabled;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.set('imapManager', { fetchMessageBody: mocks.fetchMessageBody });
  app.use((req, _res, next) => {
    req.session = { userId: USER };
    next();
  });
  app.use('/api', writingStyleRoutes);
  return app;
}

function request(path, { method = 'GET', body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

let nextUid = 100;
const sent = (n, body = {}) => Array.from({ length: n }, () => ({
  account_id: ACCOUNT.id, uid: nextUid++, folder: 'Sent', body_text: null, body_html: null, snippet: null, ...body,
}));

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  user = { ai_writing_style: null, ai_writing_style_enabled: false, ai_writing_style_samples: null, ai_writing_style_updated_at: null };
  sentRows = [];
  nextUid = 100;
  aiEnabled = true;
  mocks.getAiStatus.mockResolvedValue({ enabled: true, provider: 'api-key', features: { compose: true, summarize: true } });
  mocks.consume.mockResolvedValue({ limited: false, resetMs: 0 });
  mocks.query.mockImplementation(async (sql, params = []) => {
    if (/SELECT ai_enabled, is_admin FROM users/i.test(sql)) return { rows: [{ ai_enabled: aiEnabled, is_admin: false }] };
    if (/SELECT id FROM users/i.test(sql)) return { rows: [{ id: params[0] }] };
    if (/last_seen/i.test(sql)) return { rows: [] };
    if (/SELECT \* FROM email_accounts/i.test(sql)) return { rows: [ACCOUNT] };
    if (/FROM messages m/i.test(sql)) return { rows: sentRows };
    if (/^SELECT ai_writing_style/i.test(sql.trim())) return { rows: [user] };
    if (/^UPDATE users/i.test(sql.trim())) {
      if (/ai_writing_style = NULL/.test(sql)) {
        user = { ai_writing_style: null, ai_writing_style_enabled: false, ai_writing_style_samples: null, ai_writing_style_updated_at: null };
      } else if (/ai_writing_style_enabled = TRUE/.test(sql)) {
        user = { ai_writing_style: params[1], ai_writing_style_enabled: true, ai_writing_style_samples: params[2], ai_writing_style_updated_at: UPDATED };
      } else {
        user = { ...user, ai_writing_style: params[1], ai_writing_style_enabled: params[2], ...(params[3] ? { ai_writing_style_updated_at: UPDATED } : {}) };
      }
      return { rows: [user] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
});

describe('GET and PUT /api/ai/writing-style', () => {
  it('reads the stored style', async () => {
    user = { ai_writing_style: '- Be brief', ai_writing_style_enabled: true, ai_writing_style_samples: 9, ai_writing_style_updated_at: UPDATED };
    expect(await (await request('/api/ai/writing-style')).json())
      .toEqual({ enabled: true, profile: '- Be brief', samples: 9, updatedAt: UPDATED });
  });

  it.each([
    [{}],
    [{ enabled: 'yes' }],
    [{ profile: 42 }],
    [{ profile: ['a'] }],
    [{ profile: 'x'.repeat(2001) }],
  ])('refuses an invalid body %#', async (body) => {
    const response = await request('/api/ai/writing-style', { method: 'PUT', body });
    expect(response.status).toBe(400);
    expect(mocks.query.mock.calls.some(([sql]) => /UPDATE/.test(sql))).toBe(false);
  });

  it('saves an edited profile trimmed, and toggles it', async () => {
    const saved = await (await request('/api/ai/writing-style', { method: 'PUT', body: { profile: '  - Say hi\n', enabled: true } })).json();
    expect(saved).toMatchObject({ enabled: true, profile: '- Say hi' });
    const off = await (await request('/api/ai/writing-style', { method: 'PUT', body: { enabled: false } })).json();
    expect(off).toMatchObject({ enabled: false, profile: '- Say hi' });
  });

  it.each([null, '', '   '])('clears and turns off the style for %j', async (profile) => {
    user = { ai_writing_style: '- Be brief', ai_writing_style_enabled: true, ai_writing_style_samples: 9, ai_writing_style_updated_at: UPDATED };
    const cleared = await (await request('/api/ai/writing-style', { method: 'PUT', body: { profile, enabled: true } })).json();
    expect(cleared).toEqual({ enabled: false, profile: null, samples: null, updatedAt: null });
  });

  it('will not turn on a style that does not exist', async () => {
    const response = await request('/api/ai/writing-style', { method: 'PUT', body: { enabled: true } });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('no_profile');
  });
});

describe('POST /api/ai/writing-style/learn', () => {
  const learn = () => request('/api/ai/writing-style/learn', { method: 'POST' });

  it('learns from stored and fetched sent bodies, without the quoted mail, and stores the profile', async () => {
    sentRows = [
      ...sent(2, { body_text: 'Salut Marc,\nÇa marche pour jeudi.\nBonne soirée\n\nLe lun. 3 nov. 2025, Marc a écrit :\n> SECRET QUOTED' }),
      ...sent(1, { body_html: '<p>Merci beaucoup pour ton aide !</p><blockquote>QUOTED HTML</blockquote>' }),
      ...sent(1, { snippet: 'Je regarde ça demain matin, promis.' }),
    ];
    mocks.fetchMessageBody.mockResolvedValue({ text: 'Bonjour,\nVoici le document demandé.\nCordialement', html: null });
    mocks.completeText.mockResolvedValue('  - Write in French, tutoiement with friends.\n- Close with "Bonne soirée".  ');

    const response = await learn();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true,
      profile: '- Write in French, tutoiement with friends.\n- Close with "Bonne soirée".',
      samples: 4,
      updatedAt: UPDATED,
    });
    expect(mocks.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(mocks.fetchMessageBody).toHaveBeenCalledWith(ACCOUNT, 103, 'Sent', { background: true });
    const [messages] = mocks.completeText.mock.calls[0];
    const prompt = messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('Ça marche pour jeudi.');
    expect(prompt).toContain('Voici le document demandé.');
    expect(prompt).not.toMatch(/SECRET QUOTED|QUOTED HTML/);
    expect(messages[1].content.match(/<untrusted_email>/g)).toHaveLength(4);
    // The fetched body is only read: nothing writes it back.
    expect(mocks.query.mock.calls.some(([sql]) => /UPDATE messages|body_text\s*=/.test(sql))).toBe(false);
    expect(mocks.consume).toHaveBeenCalledWith(`ai_writing_style_learn:${USER}`, 3, 600_000);
  });

  it('reads only the Sent folder of the enabled accounts of this user', async () => {
    sentRows = sent(3, { body_text: 'Long enough sample text here.' });
    mocks.completeText.mockResolvedValue('- Be brief');
    await learn();
    const [sql, params] = mocks.query.mock.calls.find(([s]) => /FROM messages m/.test(s));
    expect(sql).toMatch(/a\.user_id = \$1/);
    expect(sql).toMatch(/a\.enabled = true/);
    expect(sql).toMatch(/is_deleted = false/);
    expect(sql).toMatch(/folder_mappings->>'sent'/);
    expect(sql).toContain("special_use = '\\Sent'");
    expect(params).toEqual([USER, 25]);
  });

  it('fetches at most twelve bodies, and skips one that fails or hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      sentRows = sent(20);
      mocks.fetchMessageBody
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue({ text: 'A fetched sample that is long enough.' });
      mocks.completeText.mockResolvedValue('- Be brief');
      const pending = learn();
      await vi.advanceTimersByTimeAsync(9000);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(mocks.fetchMessageBody).toHaveBeenCalledTimes(12);
      expect((await response.json()).samples).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses with not_enough_mail under three usable samples', async () => {
    sentRows = sent(2, { body_text: 'Long enough sample text here.' });
    const response = await learn();
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('not_enough_mail');
    expect(mocks.completeText).not.toHaveBeenCalled();
  });

  it('is rate limited', async () => {
    mocks.consume.mockResolvedValue({ limited: true, resetMs: 1000 });
    const response = await learn();
    expect(response.status).toBe(429);
    expect(mocks.completeText).not.toHaveBeenCalled();
  });

  it('is refused when the user has no AI access or the writing assistant is off', async () => {
    aiEnabled = false;
    expect((await learn()).status).toBe(403);
    aiEnabled = true;
    mocks.getAiStatus.mockResolvedValue({ enabled: true, provider: 'api-key', features: { compose: false, summarize: true } });
    const off = await learn();
    expect(off.status).toBe(403);
    expect((await off.json()).feature).toBe('compose');
    expect(mocks.completeText).not.toHaveBeenCalled();
  });

  it('hides an unexposed provider failure and shows an exposed one', async () => {
    sentRows = sent(3, { body_text: 'Long enough sample text here.' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.completeText.mockRejectedValueOnce(Object.assign(new Error('socket hang up at 10.0.0.3'), { status: 503 }));
    const hidden = await learn();
    expect(hidden.status).toBe(503);
    expect((await hidden.json()).error).toBe('AI request failed');
    mocks.completeText.mockRejectedValueOnce(Object.assign(new Error('Model quota exceeded'), { status: 502, expose: true }));
    expect((await (await learn()).json()).error).toBe('Model quota exceeded');
    logged.mockRestore();
    expect(user.ai_writing_style).toBeNull();
  });
});
