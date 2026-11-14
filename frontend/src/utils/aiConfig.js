export const AI_PROVIDER_API_KEY = 'api-key';
export const AI_PROVIDER_CHATGPT = 'chatgpt';
export const AI_PROVIDER_OPENROUTER = 'openrouter';
export const AI_PROVIDER_ANTHROPIC = 'anthropic';
export const AI_CONNECTION_METHOD_OPENROUTER = 'openrouter';
export const AI_CONNECTION_METHOD_API = 'api';
export const AI_CONNECTION_METHOD_ACCOUNT = 'account';
export const AI_CONNECTION_METHOD_ANTHROPIC = 'anthropic';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
export const DEFAULT_OPENROUTER_MODEL = 'mistralai/mistral-nemo';
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/models';
export const OPENAI_MODELS_URL = 'https://developers.openai.com/api/docs/models';
export const ANTHROPIC_KEYS_URL = 'https://console.anthropic.com/settings/keys';
// The owner limits Claude to these two, Haiku (the cheapest) first and by default. Kept in sync
// with ANTHROPIC_MODELS in backend/src/services/aiProvider.js, which refuses any other.
export const ANTHROPIC_MODEL_OPTIONS = [
  { value: 'claude-haiku-5-5', labelKey: 'admin.ai.anthropicModelHaiku' },
  { value: 'claude-sonnet-5-5', labelKey: 'admin.ai.anthropicModelSonnet' },
];
export const DEFAULT_ANTHROPIC_MODEL = ANTHROPIC_MODEL_OPTIONS[0].value;
const ANTHROPIC_MODELS = new Set(ANTHROPIC_MODEL_OPTIONS.map(({ value }) => value));

// OpenRouter comes first: one key reaches many models and it is the one we recommend.
export const AI_CONNECTION_METHOD_OPTIONS = [
  { value: AI_CONNECTION_METHOD_OPENROUTER, labelKey: 'admin.ai.connectionMethodOpenrouter' },
  { value: AI_CONNECTION_METHOD_API, labelKey: 'admin.ai.connectionMethodApi' },
  { value: AI_CONNECTION_METHOD_ACCOUNT, labelKey: 'admin.ai.connectionMethodAccount' },
  { value: AI_CONNECTION_METHOD_ANTHROPIC, labelKey: 'admin.ai.connectionMethodAnthropic' },
];
export const AI_ACCOUNT_PROVIDER_OPTIONS = [
  { value: AI_PROVIDER_CHATGPT, labelKey: 'admin.ai.subscriptionProviderChatgpt' },
];

const CONNECTION_METHODS = new Set(AI_CONNECTION_METHOD_OPTIONS.map(({ value }) => value));
const ACCOUNT_PROVIDERS = new Set(AI_ACCOUNT_PROVIDER_OPTIONS.map(({ value }) => value));

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanBaseUrl(value) {
  return cleanString(value).replace(/\/+$/, '');
}

export function normalizeAiForm(raw = {}) {
  const structured = raw.apiKeyConfig && typeof raw.apiKeyConfig === 'object';
  const apiKeyConfig = structured ? raw.apiKeyConfig : raw;
  const chatgptConfig = raw.chatgptConfig && typeof raw.chatgptConfig === 'object'
    ? raw.chatgptConfig
    : {};
  const openrouterConfig = raw.openrouterConfig && typeof raw.openrouterConfig === 'object'
    ? raw.openrouterConfig
    : {};
  const anthropicConfig = raw.anthropicConfig && typeof raw.anthropicConfig === 'object'
    ? raw.anthropicConfig
    : {};
  const anthropicModel = cleanString(anthropicConfig.model);
  const explicitConnectionMethod = cleanString(raw.connectionMethod);
  if (explicitConnectionMethod && !CONNECTION_METHODS.has(explicitConnectionMethod)) {
    throw new TypeError(`Unsupported connection method: ${explicitConnectionMethod}`);
  }
  const explicitAccountProvider = cleanString(raw.accountProvider);
  if (explicitAccountProvider && !ACCOUNT_PROVIDERS.has(explicitAccountProvider)) {
    throw new TypeError(`Unsupported account provider: ${explicitAccountProvider}`);
  }
  const hasLegacyApiConfig = !structured && Boolean(
    cleanString(raw.baseUrl) || cleanString(raw.model) || typeof raw.apiKey === 'string',
  );
  const inferredConnectionMethod = ACCOUNT_PROVIDERS.has(raw.provider)
    ? AI_CONNECTION_METHOD_ACCOUNT
    : raw.provider === AI_PROVIDER_OPENROUTER
      ? AI_CONNECTION_METHOD_OPENROUTER
      : raw.provider === AI_PROVIDER_ANTHROPIC
      ? AI_CONNECTION_METHOD_ANTHROPIC
      : raw.provider === AI_PROVIDER_API_KEY || hasLegacyApiConfig
      ? AI_CONNECTION_METHOD_API
      : '';
  const connectionMethod = explicitConnectionMethod || inferredConnectionMethod;
  const accountProvider = explicitAccountProvider
    || (ACCOUNT_PROVIDERS.has(raw.provider) ? raw.provider : '')
    || (connectionMethod === AI_CONNECTION_METHOD_ACCOUNT ? AI_PROVIDER_CHATGPT : '');
  return {
    enabled: raw.enabled !== false,
    connectionMethod,
    accountProvider,
    apiKeyConfig: {
      baseUrl: cleanBaseUrl(apiKeyConfig.baseUrl),
      apiKey: typeof apiKeyConfig.apiKey === 'string' ? apiKeyConfig.apiKey : '',
      model: cleanString(apiKeyConfig.model),
    },
    chatgptConfig: {
      model: cleanString(chatgptConfig.model) || DEFAULT_CODEX_MODEL,
    },
    openrouterConfig: {
      apiKey: typeof openrouterConfig.apiKey === 'string' ? openrouterConfig.apiKey : '',
      model: cleanString(openrouterConfig.model) || DEFAULT_OPENROUTER_MODEL,
    },
    anthropicConfig: {
      apiKey: typeof anthropicConfig.apiKey === 'string' ? anthropicConfig.apiKey : '',
      model: ANTHROPIC_MODELS.has(anthropicModel) ? anthropicModel : DEFAULT_ANTHROPIC_MODEL,
    },
    features: {
      compose: raw.features?.compose !== false,
      summarize: raw.features?.summarize !== false,
    },
    newUsersEnabled: raw.newUsersEnabled !== false,
  };
}

export function selectAiConnectionMethod(form, connectionMethod) {
  if (!CONNECTION_METHODS.has(connectionMethod)) {
    throw new TypeError(`Unsupported connection method: ${connectionMethod}`);
  }
  return normalizeAiForm({ ...form, connectionMethod });
}

export function isAiFormValid(form = {}) {
  if (!CONNECTION_METHODS.has(form.connectionMethod)) return false;
  if (form.enabled === false) return true;
  if (form.connectionMethod === AI_CONNECTION_METHOD_OPENROUTER) {
    return !!cleanString(form.openrouterConfig?.apiKey) && !!cleanString(form.openrouterConfig?.model);
  }
  if (form.connectionMethod === AI_CONNECTION_METHOD_ANTHROPIC) {
    return !!cleanString(form.anthropicConfig?.apiKey) && ANTHROPIC_MODELS.has(form.anthropicConfig?.model);
  }
  if (form.connectionMethod === AI_CONNECTION_METHOD_API) {
    return !!cleanBaseUrl(form.apiKeyConfig?.baseUrl) && !!cleanString(form.apiKeyConfig?.model);
  }
  if (form.connectionMethod === AI_CONNECTION_METHOD_ACCOUNT
      && form.accountProvider === AI_PROVIDER_CHATGPT) {
    return !!cleanString(form.chatgptConfig?.model);
  }
  return false;
}

export function buildAiSavePayload(form = {}) {
  const normalized = normalizeAiForm(form);
  if (!CONNECTION_METHODS.has(normalized.connectionMethod)) {
    throw new TypeError('Select an AI connection method before saving');
  }
  return {
    enabled: normalized.enabled,
    provider: normalized.connectionMethod === AI_CONNECTION_METHOD_ACCOUNT
      ? normalized.accountProvider
      : normalized.connectionMethod === AI_CONNECTION_METHOD_OPENROUTER
        ? AI_PROVIDER_OPENROUTER
        : normalized.connectionMethod === AI_CONNECTION_METHOD_ANTHROPIC
          ? AI_PROVIDER_ANTHROPIC
          : AI_PROVIDER_API_KEY,
    apiKeyConfig: normalized.apiKeyConfig,
    chatgptConfig: normalized.chatgptConfig,
    openrouterConfig: { ...normalized.openrouterConfig, apiKey: normalized.openrouterConfig.apiKey.trim() },
    anthropicConfig: { ...normalized.anthropicConfig, apiKey: normalized.anthropicConfig.apiKey.trim() },
    features: normalized.features,
    newUsersEnabled: normalized.newUsersEnabled,
  };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createCodexDevicePoller({
  startDevice,
  pollDevice,
  cancelDevice,
  onState,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof startDevice !== 'function' || typeof pollDevice !== 'function'
      || typeof cancelDevice !== 'function' || typeof onState !== 'function') {
    throw new TypeError('ChatGPT device poller dependencies are required');
  }

  let timer = null;
  let flow = null;
  let generation = 0;
  let disposed = false;

  function clearScheduledPoll() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function isCurrent(expectedGeneration) {
    return !disposed && expectedGeneration === generation;
  }

  function emit(state, expectedGeneration = generation) {
    if (!isCurrent(expectedGeneration)) return null;
    onState(state);
    return state;
  }

  function schedule(delay, expectedGeneration) {
    if (!isCurrent(expectedGeneration) || !flow) return;
    clearScheduledPoll();
    const boundedDelay = Math.max(0, finiteNumber(delay) ?? flow.intervalMs);
    timer = setTimer(() => pollOnce(expectedGeneration), boundedDelay);
  }

  function expireIfNeeded(expectedGeneration) {
    if (!flow || now() < flow.expiresAt) return false;
    flow = null;
    clearScheduledPoll();
    emit({ phase: 'expired' }, expectedGeneration);
    return true;
  }

  async function pollOnce(expectedGeneration) {
    timer = null;
    if (!isCurrent(expectedGeneration) || !flow || expireIfNeeded(expectedGeneration)) return;
    const activeFlow = flow;
    try {
      const response = await pollDevice(activeFlow.flowId);
      if (!isCurrent(expectedGeneration) || flow !== activeFlow) return;
      if (expireIfNeeded(expectedGeneration)) return;

      if (response?.status === 'pending') {
        schedule(response.retryAfterMs, expectedGeneration);
        return;
      }

      flow = null;
      clearScheduledPoll();
      if (response?.status === 'connected') {
        emit({ phase: 'connected' }, expectedGeneration);
      } else if (response?.status === 'failed') {
        emit({
          phase: 'failed',
          reconnectRequired: response.reconnectRequired === true,
          reason: cleanString(response.reason) || 'authorization_failed',
        }, expectedGeneration);
      } else if (['cancelled', 'expired'].includes(response?.status)) {
        emit({ phase: response.status }, expectedGeneration);
      } else {
        emit({ phase: 'error', message: 'ChatGPT authorization failed' }, expectedGeneration);
      }
    } catch {
      if (!isCurrent(expectedGeneration) || flow !== activeFlow) return;
      flow = null;
      clearScheduledPoll();
      emit({ phase: 'error', message: 'ChatGPT authorization failed' }, expectedGeneration);
    }
  }

  async function start(existingDevice = null) {
    if (disposed) throw new Error('ChatGPT device poller is disposed');
    const expectedGeneration = ++generation;
    flow = null;
    clearScheduledPoll();
    try {
      const response = existingDevice || await startDevice();
      if (!isCurrent(expectedGeneration)) return null;
      const flowId = cleanString(response?.flowId);
      const userCode = cleanString(response?.userCode);
      const verificationUrl = cleanString(response?.verificationUrl);
      const expiresAt = finiteNumber(response?.expiresAt);
      const intervalMs = finiteNumber(response?.intervalMs);
      if (!flowId || !userCode || !verificationUrl || expiresAt === null || intervalMs === null) {
        throw new Error('Invalid ChatGPT authorization response');
      }
      flow = { flowId, expiresAt, intervalMs };
      const state = emit({
        phase: 'pending',
        flowId,
        userCode,
        verificationUrl,
        expiresAt,
        retryAfterMs: intervalMs,
      }, expectedGeneration);
      schedule(intervalMs, expectedGeneration);
      return state;
    } catch (error) {
      if (isCurrent(expectedGeneration)) {
        flow = null;
        clearScheduledPoll();
        emit({ phase: 'error', message: 'Unable to start ChatGPT authorization' }, expectedGeneration);
      }
      throw error;
    }
  }

  async function cancel() {
    if (disposed) return;
    const flowId = flow?.flowId;
    const expectedGeneration = ++generation;
    flow = null;
    clearScheduledPoll();
    try {
      if (flowId) {
        await cancelDevice(flowId);
      }
      emit({ phase: 'cancelled' }, expectedGeneration);
    } catch (error) {
      emit({ phase: 'error', message: 'Unable to cancel ChatGPT authorization' }, expectedGeneration);
      throw error;
    }
  }

  function dispose() {
    disposed = true;
    generation++;
    flow = null;
    clearScheduledPoll();
  }

  return { start, cancel, dispose };
}

// Prices from /admin/ai/openrouter/models are US dollars per million tokens, shown as "$0.02 / $0.04"
// (prompt / completion).
export function formatModelPrice(model) {
  const one = (n) => {
    if (n === null || n === undefined) return '?';
    if (n === 0) return '$0';
    return `$${Number(n.toFixed(n < 1 ? 3 : 2))}`;
  };
  return `${one(model.promptPrice)} / ${one(model.completionPrice)}`;
}

// The models whose id or name contains every word typed, at most `limit`.
export function filterOpenRouterModels(models = [], search = '', limit = 50) {
  const words = cleanString(search).toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length
    ? models.filter(m => words.every(w => `${m.id} ${m.name}`.toLowerCase().includes(w)))
    : models;
  return hits.slice(0, limit);
}
