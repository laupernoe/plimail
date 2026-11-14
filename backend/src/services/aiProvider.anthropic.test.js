import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  AI_PROVIDER_ANTHROPIC,
  AiProviderError,
  MASKED_API_KEY,
  anthropicError,
  buildAnthropicRequest,
  createAiProvider,
} from './aiProvider.js';

function memorySettings(initial) {
  const rows = new Map(initial == null ? [] : [['ai_config', JSON.stringify(initial)]]);
  const keyOf = (sql, params) => (sql.includes("'ai_config'") ? 'ai_config' : params[0]);
  const queryFn = vi.fn(async (sql, params = []) => {
    if (/SELECT value FROM system_settings/i.test(sql)) {
      const value = rows.get(keyOf(sql, params));
      return { rows: value == null ? [] : [{ value }] };
    }
    if (/INSERT INTO system_settings/i.test(sql)) {
      const key = keyOf(sql, params);
      rows.set(key, key === 'ai_config' ? params[0] : params[1]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { queryFn, read: () => (rows.has('ai_config') ? JSON.parse(rows.get('ai_config')) : null) };
}

// A stand-in for the SDK client: records each create call and answers with `reply`.
function fakeClient(reply) {
  const calls = [];
  const answer = async (body, options) => {
    calls.push({ body, options });
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(body) : reply;
  };
  return {
    calls,
    client: { messages: { create: vi.fn(answer) }, beta: { messages: { create: vi.fn(answer) } } },
  };
}

function setup({ model = 'claude-haiku-5-5', reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] } } = {}) {
  const settings = memorySettings({
    enabled: true,
    provider: AI_PROVIDER_ANTHROPIC,
    anthropicConfig: { apiKey: 'encrypted:sk-ant-secret', model },
  });
  const fake = fakeClient(reply);
  const createAnthropicClientFn = vi.fn(() => fake.client);
  const provider = createAiProvider({
    queryFn: settings.queryFn,
    encryptFn: (value) => `encrypted:${value}`,
    decryptFn: (value) => value?.replace(/^encrypted:/, ''),
    fetchFn: vi.fn(() => { throw new Error('the Claude path must not use raw fetch'); }),
    createAnthropicClientFn,
  });
  return { provider, settings, fake, createAnthropicClientFn };
}

function apiError(Class, status, message = 'nope') {
  return new Class(status, { type: 'error', error: { type: 'x', message } }, message, new Headers());
}

describe('buildAnthropicRequest', () => {
  const messages = [
    { role: 'system', content: 'Be brief.' },
    { role: 'system', content: 'Answer in French.' },
    { role: 'user', content: 'Hi' },
  ];

  it('sends no sampling parameters, no thinking override and low effort', () => {
    const body = buildAnthropicRequest('claude-haiku-5-5', messages, { maxTokens: 2000 });
    expect(body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 2000,
      system: 'Be brief.\n\nAnswer in French.',
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: { effort: 'low' },
    });
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'betas', 'fallbacks']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('adds server-side fallbacks for Sonnet only', () => {
    const sonnet = buildAnthropicRequest('claude-sonnet-5-5', messages);
    expect(sonnet.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(sonnet.fallbacks).toBe('default');
    expect(sonnet).not.toHaveProperty('temperature');
    const haiku = buildAnthropicRequest('claude-haiku-5-5', messages);
    expect(haiku).not.toHaveProperty('fallbacks');
    expect(haiku).not.toHaveProperty('betas');
  });

  it('asks for structured output with a JSON schema', () => {
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    const body = buildAnthropicRequest('claude-haiku-5-5', messages, { jsonSchema: schema });
    expect(body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema } });
  });

  it('refuses an assistant prefill, which these models reject', () => {
    expect(() => buildAnthropicRequest('claude-haiku-5-5', [
      { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Sure, ' },
    ])).toThrow(AiProviderError);
  });

  it('keeps room for thinking under a tiny max_tokens', () => {
    expect(buildAnthropicRequest('claude-haiku-5-5', messages, { maxTokens: 16 }).max_tokens).toBe(512);
    expect(buildAnthropicRequest('claude-haiku-5-5', messages).max_tokens).toBe(8192);
  });
});

describe('Claude provider', () => {
  it('stores the key encrypted, masks it, and only accepts Haiku or Sonnet', async () => {
    const settings = memorySettings(null);
    const provider = createAiProvider({
      queryFn: settings.queryFn,
      encryptFn: (value) => `encrypted:${value}`,
      decryptFn: (value) => value?.replace(/^encrypted:/, ''),
    });
    const saved = await provider.saveAiConfig({
      enabled: true, provider: AI_PROVIDER_ANTHROPIC, anthropicConfig: { apiKey: ' sk-ant-1 ', model: 'claude-sonnet-5-5' },
    });
    expect(settings.read().anthropicConfig).toEqual({ apiKey: 'encrypted:sk-ant-1', model: 'claude-sonnet-5-5' });
    expect(saved.anthropicConfig.apiKey).toBe(MASKED_API_KEY);

    await provider.saveAiConfig({
      enabled: true, provider: AI_PROVIDER_ANTHROPIC, anthropicConfig: { apiKey: MASKED_API_KEY, model: 'claude-haiku-5-5' },
    });
    expect(settings.read().anthropicConfig.apiKey).toBe('encrypted:sk-ant-1');

    await expect(provider.saveAiConfig({
      enabled: true, provider: AI_PROVIDER_ANTHROPIC, anthropicConfig: { apiKey: 'k', model: 'claude-opus-5-5' },
    })).rejects.toMatchObject({ status: 400 });
  });

  it('requires a key to enable it', async () => {
    const provider = createAiProvider({ queryFn: memorySettings(null).queryFn, encryptFn: v => v, decryptFn: v => v });
    await expect(provider.saveAiConfig({ enabled: true, provider: AI_PROVIDER_ANTHROPIC, anthropicConfig: {} }))
      .rejects.toThrow(/Anthropic API key is required/);
  });

  it('completes through messages.create with the decrypted key and reads text blocks only', async () => {
    const { provider, fake, createAnthropicClientFn } = setup({
      reply: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'ok' }] },
    });
    const signal = new AbortController().signal;
    expect(await provider.completeText([{ role: 'user', content: 'Hi' }], { maxTokens: 1024, signal })).toBe('ok');
    expect(createAnthropicClientFn).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ant-secret' }));
    expect(fake.client.messages.create).toHaveBeenCalledTimes(1);
    expect(fake.client.beta.messages.create).not.toHaveBeenCalled();
    expect(fake.calls[0].options.signal).toBe(signal);
    expect(fake.calls[0].body).not.toHaveProperty('temperature');
    expect(fake.calls[0].body.output_config).toEqual({ effort: 'low' });
  });

  it('uses the beta endpoint with fallbacks for Sonnet', async () => {
    const { provider, fake } = setup({ model: 'claude-sonnet-5-5' });
    await provider.completeText([{ role: 'user', content: 'Hi' }]);
    expect(fake.client.messages.create).not.toHaveBeenCalled();
    expect(fake.calls[0].body).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  });

  it('turns a refusal into a clear error before reading content', async () => {
    const { provider } = setup({
      reply: { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [{ type: 'text', text: 'partial' }] },
    });
    await expect(provider.completeText([{ role: 'user', content: 'Hi' }]))
      .rejects.toMatchObject({ name: 'AiProviderError', message: 'Claude declined this request (cyber)', expose: true });
  });

  it('streams text deltas and stops on a refusal', async () => {
    async function* events() {
      yield { type: 'content_block_start', content_block: { type: 'thinking' } };
      yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Bon' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'jour' } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
    }
    const { provider, fake } = setup({ reply: () => events() });
    const chunks = [];
    for await (const chunk of provider.streamChat([{ role: 'user', content: 'Hi' }])) chunks.push(chunk);
    expect(chunks).toEqual(['Bon', 'jour']);
    expect(fake.calls[0].body.stream).toBe(true);

    async function* refused() {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } };
      yield { type: 'message_delta', delta: { stop_reason: 'refusal' } };
    }
    const { provider: refusing } = setup({ reply: () => refused() });
    await expect((async () => { const iterator = refusing.streamChat([{ role: 'user', content: 'Hi' }]); while (!(await iterator.next()).done) { /* drain */ } })())
      .rejects.toThrow(/Claude declined/);
  });

  it.each([
    [() => apiError(Anthropic.AuthenticationError, 401), /rejected the API key \(401\)/, 502],
    [() => apiError(Anthropic.RateLimitError, 429), /rate limiting/, 429],
    [() => apiError(Anthropic.InternalServerError, 529), /unavailable \(529\)/, 503],
  ])('maps SDK error %#', async (make, message, status) => {
    const { provider } = setup({ reply: make() });
    await expect(provider.completeText([{ role: 'user', content: 'Hi' }])).rejects.toMatchObject({ message: expect.stringMatching(message), status, expose: true });
  });

  it('never echoes the key in an error', () => {
    const error = anthropicError(apiError(Anthropic.BadRequestError, 400, 'bad key sk-ant-secret here'), { apiKey: 'sk-ant-secret' });
    expect(error.message).not.toContain('sk-ant-secret');
    expect(error.message).toContain('[redacted]');
  });

  it('is enabled in the status once a key is stored, and the test call succeeds on an empty reply', async () => {
    const { provider } = setup({ reply: { stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] } });
    expect(await provider.getAiStatus()).toMatchObject({ enabled: true, provider: AI_PROVIDER_ANTHROPIC });
    expect(await provider.testAiProvider()).toEqual({ ok: true });
  });
});
