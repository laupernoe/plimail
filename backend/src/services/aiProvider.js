import Anthropic from '@anthropic-ai/sdk';
import { decrypt, encrypt } from './encryption.js';
import { query } from './db.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { validateHost } from './hostValidation.js';
import { createRequestSignal, parseJson, readLimited, readSseData, sanitizeText } from './aiHttp.js';
import { completeCodexText, streamCodexResponses } from './openaiCodexResponses.js';
import { getCodexAccess, getCodexStatus } from './openaiCodexAuth.js';
import { aiEnabledForNewUser, setAiEnabledForNewUser } from './aiNewUsers.js';

export const AI_PROVIDER_API_KEY = 'api-key';
export const AI_PROVIDER_CHATGPT = 'chatgpt';
export const AI_PROVIDER_OPENROUTER = 'openrouter';
export const AI_PROVIDER_ANTHROPIC = 'anthropic';
export const MASKED_API_KEY = '••••••••';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_MODEL = 'mistralai/mistral-nemo';
// The owner limits Claude to these two: Haiku, the cheapest, by default, and Sonnet.
export const ANTHROPIC_MODELS = Object.freeze(['claude-haiku-5-5', 'claude-sonnet-5-5']);
export const DEFAULT_ANTHROPIC_MODEL = ANTHROPIC_MODELS[0];
// Sonnet 5.5 can hand a declined request to another model inside the same call; Haiku 5.5 has no
// server-side fallback, and sending the parameter to it is pointless or a 400.
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-sonnet-5-5']);
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;
// Thinking counts toward max_tokens on these models, so a tiny cap (the connection test asks for
// 16) could be spent before any text.
const ANTHROPIC_MIN_MAX_TOKENS = 512;

const PROVIDERS = new Set([AI_PROVIDER_API_KEY, AI_PROVIDER_CHATGPT, AI_PROVIDER_OPENROUTER, AI_PROVIDER_ANTHROPIC]);
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const SSE_EVENT_LIMIT_BYTES = 256 * 1024;
const OUTPUT_LIMIT_CHARS = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export class AiProviderError extends Error {
  // `expose` marks an error whose message is safe to show the caller (already
  // secret-redacted and sanitized) — provider-originated failures set it so the
  // admin sees the real reason instead of a generic message, even on a 5xx.
  constructor(message, { status = 503, expose = false } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
    this.expose = expose;
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  return cleanString(value).replace(/\/+$/, '');
}

export function normalizeAiConfig(raw = {}) {
  const hasStructuredConfig = raw.apiKeyConfig && typeof raw.apiKeyConfig === 'object';
  const apiSource = hasStructuredConfig ? raw.apiKeyConfig : raw;
  const chatgptSource = raw.chatgptConfig && typeof raw.chatgptConfig === 'object'
    ? raw.chatgptConfig
    : {};
  const openrouterSource = raw.openrouterConfig && typeof raw.openrouterConfig === 'object'
    ? raw.openrouterConfig
    : {};
  const anthropicSource = raw.anthropicConfig && typeof raw.anthropicConfig === 'object'
    ? raw.anthropicConfig
    : {};
  const anthropicModel = cleanString(anthropicSource.model);
  const provider = PROVIDERS.has(raw.provider) ? raw.provider : AI_PROVIDER_API_KEY;
  return {
    enabled: raw.enabled !== false,
    provider,
    apiKeyConfig: {
      baseUrl: normalizeBaseUrl(apiSource.baseUrl),
      apiKey: apiSource.apiKey || null,
      model: cleanString(apiSource.model),
    },
    chatgptConfig: {
      model: cleanString(chatgptSource.model) || DEFAULT_CODEX_MODEL,
    },
    openrouterConfig: {
      apiKey: openrouterSource.apiKey || null,
      model: cleanString(openrouterSource.model) || DEFAULT_OPENROUTER_MODEL,
    },
    anthropicConfig: {
      apiKey: anthropicSource.apiKey || null,
      model: ANTHROPIC_MODELS.includes(anthropicModel) ? anthropicModel : DEFAULT_ANTHROPIC_MODEL,
    },
    features: {
      compose: raw.features?.compose !== false,
      summarize: raw.features?.summarize !== false,
    },
  };
}

function publicConfig(config) {
  if (!config) return null;
  return {
    ...config,
    apiKeyConfig: {
      ...config.apiKeyConfig,
      apiKey: config.apiKeyConfig.apiKey ? MASKED_API_KEY : '',
    },
    openrouterConfig: {
      ...config.openrouterConfig,
      apiKey: config.openrouterConfig.apiKey ? MASKED_API_KEY : '',
    },
    anthropicConfig: {
      ...config.anthropicConfig,
      apiKey: config.anthropicConfig.apiKey ? MASKED_API_KEY : '',
    },
  };
}

// OpenRouter asks apps to say who they are (HTTP-Referer, X-Title). Fixed values on purpose:
// the instance's own address or name would identify the deployment, so only the app goes out.
export function openRouterAttributionHeaders() {
  return { 'HTTP-Referer': 'https://github.com/laupernoe/plimail', 'X-Title': 'Plimail' };
}

function redactSecrets(value, secrets = []) {
  let redacted = value;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function providerError(status, text, secrets = []) {
  const parsed = parseJson(text);
  const raw = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message;
  const detail = sanitizeText(redactSecrets(raw || text, secrets));
  return new AiProviderError(`AI provider error (${status})${detail ? `: ${detail}` : ''}`, { status: 502, expose: true });
}

function providerRequestError(error, request, callerSignal) {
  if (request.timedOut()) return new AiProviderError('AI provider request timed out', { status: 504, expose: true });
  if (callerSignal?.aborted) return new AiProviderError('AI provider request was aborted', { status: 499, expose: true });
  if (error instanceof AiProviderError) return error;
  return new AiProviderError(
    `AI provider request failed: ${sanitizeText(error?.message) || 'network error'}`,
    { status: 502, expose: true },
  );
}

// Redirects are not followed. The base URL's host is checked against the private-host policy when
// it is saved (saveConfig); a redirect would send the request, with a 307 its body (the email text
// being summarized or drafted) too, to a host that was never checked, one the policy forbids among
// them. fetch drops the API key on a redirect to another origin.
async function openProviderRequest(fetchFn, url, init, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const request = createRequestSignal(signal, timeoutMs, 'AI request timed out');
  let response;
  try {
    response = await fetchFn(url, { ...init, redirect: 'manual', signal: request.signal });
  } catch (error) {
    request.cleanup();
    throw providerRequestError(error, request, signal);
  }
  if (response.status >= 300 && response.status < 400) {
    request.cleanup();
    response.body?.cancel().catch(() => {});
    throw new AiProviderError(
      `AI provider redirected the request (${response.status}); set the API base URL to the address it redirects to`,
      { status: 502, expose: true },
    );
  }
  return { ...request, response };
}

async function* parseChatCompletionsSse(response, { signal, secrets } = {}) {
  let outputChars = 0;
  const createError = (reason) => {
    if (reason === 'empty_body') return new AiProviderError('AI provider returned an empty stream', { status: 502 });
    if (reason === 'aborted') return new AiProviderError('AI provider request was aborted', { status: 499 });
    return new AiProviderError('AI provider stream event was too large', { status: 502 });
  };

  for await (const data of readSseData(response, {
    signal,
    maxEventBytes: SSE_EVENT_LIMIT_BYTES,
    createError,
  })) {
    if (data.trim() === '[DONE]') return;
    const event = parseJson(data);
    if (!event) throw new AiProviderError('AI provider returned a malformed stream event', { status: 502 });
    if (event.error) throw providerError(502, JSON.stringify({ error: event.error }), secrets);
    const delta = event.choices?.[0]?.delta?.content;
    if (typeof delta !== 'string' || !delta) continue;
    outputChars += delta.length;
    if (outputChars > OUTPUT_LIMIT_CHARS) throw new AiProviderError('AI provider output was too large', { status: 502 });
    yield delta;
  }
}

// ── Anthropic (Claude) ─────────────────────────────────────────────────────────
//
// The Claude API through the official SDK. Claude Haiku 5.5 and Sonnet 5.5 reject non-default
// temperature/top_p/top_k, a final assistant turn (prefill) and, on Sonnet, thinking disabled, so
// none of those are sent: thinking stays at its default and effort is low, which suits these short
// mail tasks. Sonnet's declines are retried server-side on another model; Haiku has no fallback.

// The provider abstraction speaks OpenAI-style messages; system messages become the top-level
// `system`, the rest stay in order. `jsonSchema` asks for structured output.
export function buildAnthropicRequest(model, messages, { maxTokens, jsonSchema, stream = false } = {}) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    throw new AiProviderError('The last message sent to Claude must be from the user', { status: 400 });
  }
  const outputConfig = { effort: 'low' };
  if (jsonSchema) outputConfig.format = { type: 'json_schema', schema: jsonSchema };
  const body = {
    model,
    max_tokens: Math.max(ANTHROPIC_MIN_MAX_TOKENS, Number.isFinite(maxTokens) ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS),
    ...(system ? { system } : {}),
    messages: turns,
    output_config: outputConfig,
    ...(stream ? { stream: true } : {}),
  };
  if (ANTHROPIC_FALLBACK_MODELS.has(model)) {
    body.betas = [ANTHROPIC_FALLBACK_BETA];
    body.fallbacks = 'default';
  }
  return body;
}

function anthropicRefusal(details) {
  const category = typeof details?.category === 'string' ? ` (${sanitizeText(details.category)})` : '';
  return new AiProviderError(`Claude declined this request${category}`, { status: 422, expose: true });
}

// The SDK's typed errors, as the messages an admin can act on. The key never appears: the SDK's
// messages carry the API's error text, not the request headers, and it is redacted besides.
export function anthropicError(error, { apiKey, callerSignal } = {}) {
  if (error instanceof AiProviderError) return error;
  if (error instanceof Anthropic.APIUserAbortError || callerSignal?.aborted) {
    return new AiProviderError('AI provider request was aborted', { status: 499, expose: true });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiProviderError('AI provider request timed out', { status: 504, expose: true });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiProviderError('Could not reach the Claude API', { status: 502, expose: true });
  }
  const detail = sanitizeText(redactSecrets(error?.error?.error?.message || error?.message || '', [apiKey]));
  const suffix = detail ? `: ${detail}` : '';
  if (error instanceof Anthropic.AuthenticationError) {
    return new AiProviderError('Anthropic rejected the API key (401). Check the key in the AI settings.', { status: 502, expose: true });
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError(`This Anthropic API key may not use this model (403)${suffix}`, { status: 502, expose: true });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiProviderError('The Claude API is rate limiting this key (429). Try again in a moment.', { status: 429, expose: true });
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new AiProviderError(`The Claude API is unavailable (${error.status ?? 'server error'}). Try again later.`, { status: 503, expose: true });
  }
  if (error instanceof Anthropic.APIError) {
    return new AiProviderError(`AI provider error (${error.status ?? 'unknown'})${suffix}`, { status: 502, expose: true });
  }
  return new AiProviderError(`AI provider request failed: ${sanitizeText(error?.message) || 'unknown error'}`, { status: 502, expose: true });
}

// The text of a finished response, read by block type: a response can open with thinking blocks.
export function anthropicResponseText(response, { allowEmpty = false } = {}) {
  if (response?.stop_reason === 'refusal') throw anthropicRefusal(response.stop_details);
  const text = (response?.content || [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
  if (text || allowEmpty) return text;
  throw new AiProviderError(
    `AI provider returned an empty completion (stop_reason: ${sanitizeText(String(response?.stop_reason || 'unknown'))})`,
    { status: 502, expose: true },
  );
}

function defaultAnthropicClient(options) {
  return new Anthropic(options);
}

export function createAiProvider({
  queryFn = query,
  encryptFn = encrypt,
  decryptFn = decrypt,
  validateHostFn = validateHost,
  getConnectionPolicyFn = getConnectionPolicy,
  fetchFn = (...args) => fetch(...args),
  getCodexAccessFn = getCodexAccess,
  getCodexStatusFn = getCodexStatus,
  streamCodexResponsesFn = streamCodexResponses,
  completeCodexTextFn = completeCodexText,
  createAnthropicClientFn = defaultAnthropicClient,
} = {}) {
  async function loadAiConfig() {
    const result = await queryFn("SELECT value FROM system_settings WHERE key = 'ai_config'");
    if (!result.rows.length) return null;
    const parsed = parseJson(result.rows[0].value);
    return parsed ? normalizeAiConfig(parsed) : null;
  }

  // "Allow AI for new users" (#644) is stored apart from the provider configuration (see
  // aiNewUsers.js) and shown with it.
  async function getAiNewUsersEnabled() {
    return aiEnabledForNewUser({ query: queryFn });
  }

  async function withNewUsersEnabled(config) {
    return config ? { ...publicConfig(config), newUsersEnabled: await getAiNewUsersEnabled() } : null;
  }

  async function getAdminAiConfig() {
    return withNewUsersEnabled(await loadAiConfig());
  }

  async function saveAiConfig(input = {}) {
    if (!PROVIDERS.has(input.provider)) throw new AiProviderError('Unknown AI provider', { status: 400 });
    if (input.enabled !== false && input.provider === AI_PROVIDER_CHATGPT
        && !cleanString(input.chatgptConfig?.model)) {
      throw new AiProviderError('ChatGPT model name is required', { status: 400 });
    }
    const existing = await loadAiConfig();
    const incomingApi = input.apiKeyConfig || {};
    const incomingKey = incomingApi.apiKey;
    const storedKey = typeof incomingKey === 'string' && incomingKey && incomingKey !== MASKED_API_KEY
      ? encryptFn(incomingKey)
      : (existing?.apiKeyConfig.apiKey || null);
    const incomingRouter = input.openrouterConfig || {};
    const routerKey = incomingRouter.apiKey;
    const storedRouterKey = typeof routerKey === 'string' && routerKey.trim() && routerKey !== MASKED_API_KEY
      ? encryptFn(routerKey.trim())
      : (existing?.openrouterConfig.apiKey || null);
    const incomingAnthropic = input.anthropicConfig || {};
    const anthropicKey = incomingAnthropic.apiKey;
    const storedAnthropicKey = typeof anthropicKey === 'string' && anthropicKey.trim() && anthropicKey !== MASKED_API_KEY
      ? encryptFn(anthropicKey.trim())
      : (existing?.anthropicConfig.apiKey || null);
    const anthropicModel = cleanString(incomingAnthropic.model);
    if (anthropicModel && !ANTHROPIC_MODELS.includes(anthropicModel)) {
      throw new AiProviderError(`Claude model must be one of: ${ANTHROPIC_MODELS.join(', ')}`, { status: 400 });
    }
    const config = normalizeAiConfig({
      ...input,
      apiKeyConfig: { ...incomingApi, apiKey: storedKey },
      openrouterConfig: { ...incomingRouter, apiKey: storedRouterKey },
      anthropicConfig: { ...incomingAnthropic, apiKey: storedAnthropicKey },
    });

    if (config.enabled && config.provider === AI_PROVIDER_OPENROUTER && !config.openrouterConfig.apiKey) {
      throw new AiProviderError('OpenRouter API key is required', { status: 400 });
    }
    if (config.enabled && config.provider === AI_PROVIDER_ANTHROPIC && !config.anthropicConfig.apiKey) {
      throw new AiProviderError('Anthropic API key is required', { status: 400 });
    }

    if (config.enabled && config.provider === AI_PROVIDER_API_KEY
        && (!config.apiKeyConfig.baseUrl || !config.apiKeyConfig.model)) {
      throw new AiProviderError('API base URL and model name are required', { status: 400 });
    }
    if (config.provider === AI_PROVIDER_API_KEY && config.apiKeyConfig.baseUrl) {
      let hostname;
      try {
        hostname = new URL(config.apiKeyConfig.baseUrl).hostname;
      } catch {
        throw new AiProviderError('Invalid API base URL', { status: 400 });
      }
      const policy = await getConnectionPolicyFn();
      const hostError = await validateHostFn(hostname, { allowPrivate: policy.allowPrivateHosts });
      if (hostError) throw new AiProviderError(`API base URL: ${hostError}`, { status: 400 });
    }

    await queryFn(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('ai_config', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(config)],
    );
    // Only a boolean changes it, so a save from an admin tab that predates the setting keeps it.
    if (typeof input.newUsersEnabled === 'boolean') {
      await setAiEnabledForNewUser(input.newUsersEnabled, { query: queryFn });
    }
    return withNewUsersEnabled(config);
  }

  async function deleteAiConfig() {
    await queryFn("DELETE FROM system_settings WHERE key = 'ai_config'");
  }

  async function requireSelectedConfig() {
    const config = await loadAiConfig();
    if (!config) throw new AiProviderError('AI provider not configured');
    if (!config.enabled) throw new AiProviderError('AI features are disabled');
    if (config.provider === AI_PROVIDER_API_KEY
        && (!config.apiKeyConfig.baseUrl || !config.apiKeyConfig.model)) {
      throw new AiProviderError('AI provider not fully configured');
    }
    if (config.provider === AI_PROVIDER_OPENROUTER && !config.openrouterConfig.apiKey) {
      throw new AiProviderError('AI provider not fully configured');
    }
    if (config.provider === AI_PROVIDER_ANTHROPIC && !config.anthropicConfig.apiKey) {
      throw new AiProviderError('AI provider not fully configured');
    }
    return config;
  }

  // OpenRouter speaks the OpenAI chat-completions protocol, so it shares the api-key code path with
  // a fixed base URL, its own key and model, and the attribution headers.
  function apiEndpoint(config) {
    if (config.provider === AI_PROVIDER_OPENROUTER) {
      const key = config.openrouterConfig.apiKey;
      return {
        baseUrl: OPENROUTER_BASE_URL,
        apiKey: key ? decryptFn(key) : null,
        model: config.openrouterConfig.model,
        extraHeaders: openRouterAttributionHeaders(),
      };
    }
    const key = config.apiKeyConfig.apiKey;
    return {
      baseUrl: config.apiKeyConfig.baseUrl,
      apiKey: key ? decryptFn(key) : null,
      model: config.apiKeyConfig.model,
      extraHeaders: {},
    };
  }

  function apiKeyHeaders(apiKey, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  async function completeApiKey(config, messages, { signal, maxTokens, allowEmpty = false } = {}) {
    const { apiKey, baseUrl, model, extraHeaders } = apiEndpoint(config);
    const body = {
      model,
      messages,
      ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
      stream: false,
    };
    const request = await openProviderRequest(fetchFn, `${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: apiKeyHeaders(apiKey, extraHeaders),
      body: JSON.stringify(body),
    }, { signal });
    try {
      const { response } = request;
      const text = await readLimited(response, response.ok ? JSON_BODY_LIMIT_BYTES : ERROR_BODY_LIMIT_BYTES);
      if (!response.ok) throw providerError(response.status, text, [apiKey]);
      const parsed = parseJson(text);
      const choice = parsed?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content === 'string') return content;
      // A reasoning model — or any turn truncated by max_tokens — can return a
      // null `content`: the output went entirely to reasoning, or the budget was
      // spent before any text was emitted. That is a well-formed response, not a
      // transport failure. Callers that only need to confirm the endpoint works
      // (the connection test) accept it as empty; real completions surface the
      // finish reason instead of a generic error.
      if (choice && content == null) {
        if (allowEmpty) return '';
        const reason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';
        throw new AiProviderError(
          `AI provider returned an empty completion (finish_reason: ${reason})`,
          { status: 502, expose: true },
        );
      }
      throw new AiProviderError('AI provider returned an invalid completion', { status: 502, expose: true });
    } catch (error) {
      throw providerRequestError(error, request, signal);
    } finally {
      request.cleanup();
    }
  }

  async function* streamApiKey(config, messages, { signal } = {}) {
    const { apiKey, baseUrl, model, extraHeaders } = apiEndpoint(config);
    const request = await openProviderRequest(fetchFn, `${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: apiKeyHeaders(apiKey, extraHeaders),
      body: JSON.stringify({ model, messages, stream: true }),
    }, { signal, timeoutMs: 120_000 });
    try {
      const { response } = request;
      if (!response.ok) {
        const text = await readLimited(response, ERROR_BODY_LIMIT_BYTES);
        throw providerError(response.status, text, [apiKey]);
      }
      yield* parseChatCompletionsSse(response, { signal: request.signal, secrets: [apiKey] });
    } catch (error) {
      throw providerRequestError(error, request, signal);
    } finally {
      request.cleanup();
    }
  }

  function anthropicClient(config) {
    const apiKey = decryptFn(config.anthropicConfig.apiKey);
    // The SDK retries 429 and 5xx itself; two retries keep a slow failure under the route's patience.
    return { apiKey, client: createAnthropicClientFn({ apiKey, maxRetries: 2, timeout: DEFAULT_TIMEOUT_MS }) };
  }

  function anthropicCreate(client, body, options) {
    const { betas } = body;
    return betas ? client.beta.messages.create(body, options) : client.messages.create(body, options);
  }

  async function completeAnthropic(config, messages, { signal, maxTokens, allowEmpty = false, jsonSchema } = {}) {
    const body = buildAnthropicRequest(config.anthropicConfig.model, messages, { maxTokens, jsonSchema });
    const { apiKey, client } = anthropicClient(config);
    let response;
    try {
      response = await anthropicCreate(client, body, { signal });
    } catch (error) {
      throw anthropicError(error, { apiKey, callerSignal: signal });
    }
    return anthropicResponseText(response, { allowEmpty });
  }

  async function* streamAnthropic(config, messages, { signal, maxTokens } = {}) {
    const body = buildAnthropicRequest(config.anthropicConfig.model, messages, { maxTokens, stream: true });
    const { apiKey, client } = anthropicClient(config);
    let outputChars = 0;
    try {
      const stream = await anthropicCreate(client, body, { signal, timeout: 120_000 });
      for await (const event of stream) {
        if (event?.type === 'message_delta' && event.delta?.stop_reason === 'refusal') {
          throw anthropicRefusal(event.delta.stop_details);
        }
        if (event?.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') continue;
        const text = event.delta.text;
        if (typeof text !== 'string' || !text) continue;
        outputChars += text.length;
        if (outputChars > OUTPUT_LIMIT_CHARS) throw new AiProviderError('AI provider output was too large', { status: 502 });
        yield text;
      }
    } catch (error) {
      throw anthropicError(error, { apiKey, callerSignal: signal });
    }
  }

  function codexRequest(config, messages, options, credentials) {
    return {
      ...credentials,
      model: config.chatgptConfig.model,
      messages,
      signal: options.signal,
    };
  }

  async function completeText(messages, options = {}) {
    const config = await requireSelectedConfig();
    if (config.provider === AI_PROVIDER_ANTHROPIC) return completeAnthropic(config, messages, options);
    if (config.provider !== AI_PROVIDER_CHATGPT) return completeApiKey(config, messages, options);
    let credentials = await getCodexAccessFn();
    try {
      return await completeCodexTextFn(codexRequest(config, messages, options, credentials));
    } catch (error) {
      if (error?.status !== 401) throw error;
      credentials = await getCodexAccessFn({ forceRefresh: true });
      return completeCodexTextFn(codexRequest(config, messages, options, credentials));
    }
  }

  async function* streamChat(messages, options = {}) {
    const config = await requireSelectedConfig();
    if (config.provider === AI_PROVIDER_ANTHROPIC) {
      yield* streamAnthropic(config, messages, options);
      return;
    }
    if (config.provider !== AI_PROVIDER_CHATGPT) {
      yield* streamApiKey(config, messages, options);
      return;
    }

    let forceRefresh = false;
    for (;;) {
      const credentials = forceRefresh
        ? await getCodexAccessFn({ forceRefresh: true })
        : await getCodexAccessFn();
      let emitted = false;
      try {
        for await (const delta of streamCodexResponsesFn(codexRequest(config, messages, options, credentials))) {
          emitted = true;
          yield delta;
        }
        return;
      } catch (error) {
        if (forceRefresh || emitted || error?.status !== 401) throw error;
        forceRefresh = true;
      }
    }
  }

  async function getAiStatus() {
    const config = await loadAiConfig();
    if (!config || !config.enabled) {
      return {
        enabled: false,
        provider: config?.provider || AI_PROVIDER_API_KEY,
        features: config?.features || {},
        reconnectRequired: false,
      };
    }
    if (config.provider === AI_PROVIDER_API_KEY) {
      const enabled = Boolean(config.apiKeyConfig.baseUrl && config.apiKeyConfig.model);
      return { enabled, provider: config.provider, features: config.features, reconnectRequired: false };
    }
    if (config.provider === AI_PROVIDER_OPENROUTER) {
      const enabled = Boolean(config.openrouterConfig.apiKey && config.openrouterConfig.model);
      return { enabled, provider: config.provider, features: config.features, reconnectRequired: false };
    }
    if (config.provider === AI_PROVIDER_ANTHROPIC) {
      const enabled = Boolean(config.anthropicConfig.apiKey);
      return { enabled, provider: config.provider, features: config.features, reconnectRequired: false };
    }
    const connection = await getCodexStatusFn();
    return {
      enabled: connection.connected === true && Boolean(config.chatgptConfig.model),
      provider: config.provider,
      features: config.features,
      reconnectRequired: connection.reconnectRequired === true,
      connection,
    };
  }

  async function testAiProvider() {
    // The connection test only needs to prove the endpoint is reachable, the key
    // is accepted, and the model returns a well-formed completion. `allowEmpty`
    // keeps it from failing on reasoning models that spend the small token budget
    // on reasoning and return empty content (see completeApiKey).
    await completeText(
      [{ role: 'user', content: 'Reply with only the word "ok".' }],
      { maxTokens: 16, allowEmpty: true },
    );
    return { ok: true };
  }

  // The public model catalogue (no key needed): id, name, context length and prices per million
  // tokens, so the admin can pick a model knowing what it costs. Cheapest first within a search.
  async function listOpenRouterModels({ signal } = {}) {
    const request = await openProviderRequest(fetchFn, `${OPENROUTER_BASE_URL}/models`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...openRouterAttributionHeaders() },
    }, { signal, timeoutMs: 20_000 });
    try {
      const { response } = request;
      const text = await readLimited(response, response.ok ? 8 * 1024 * 1024 : ERROR_BODY_LIMIT_BYTES);
      if (!response.ok) throw providerError(response.status, text);
      const data = parseJson(text)?.data;
      if (!Array.isArray(data)) throw new AiProviderError('OpenRouter returned an invalid model list', { status: 502, expose: true });
      const perMillion = (value) => {
        const n = Number.parseFloat(value);
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : null;
      };
      return data
        .filter(m => typeof m?.id === 'string' && m.id)
        .map(m => ({
          id: m.id,
          name: typeof m.name === 'string' && m.name ? m.name : m.id,
          contextLength: Number.isFinite(m.context_length) ? m.context_length : null,
          promptPrice: perMillion(m.pricing?.prompt),
          completionPrice: perMillion(m.pricing?.completion),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) {
      throw providerRequestError(error, request, signal);
    } finally {
      request.cleanup();
    }
  }

  return {
    listOpenRouterModels,
    loadAiConfig,
    getAdminAiConfig,
    getAiNewUsersEnabled,
    saveAiConfig,
    deleteAiConfig,
    getAiStatus,
    testAiProvider,
    streamChat,
    completeText,
  };
}

const defaultProvider = createAiProvider();

export const listOpenRouterModels = defaultProvider.listOpenRouterModels;
export const loadAiConfig = defaultProvider.loadAiConfig;
export const getAdminAiConfig = defaultProvider.getAdminAiConfig;
export const getAiNewUsersEnabled = defaultProvider.getAiNewUsersEnabled;
export const saveAiConfig = defaultProvider.saveAiConfig;
export const deleteAiConfig = defaultProvider.deleteAiConfig;
export const getAiStatus = defaultProvider.getAiStatus;
export const testAiProvider = defaultProvider.testAiProvider;
export const streamChat = defaultProvider.streamChat;
export const completeText = defaultProvider.completeText;
