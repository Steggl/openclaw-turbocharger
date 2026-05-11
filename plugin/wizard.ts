export const PROVIDER_ID = 'openclaw-turbocharger';
export const DEFAULT_BASE_URL = 'http://localhost:11435/v1';
export const DEFAULT_API_KEY = 'n/a';
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_TOKENS = 8192;

export const DEFAULT_MODEL_REFS = [
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-opus-4-7',
  'qwen2.5:7b',
] as const;

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  let normalized = trimmed;
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized.endsWith('/v1')) {
    normalized = `${normalized}/v1`;
  }
  return normalized;
}

export function validateBaseUrl(value: string): string | undefined {
  const normalized = normalizeBaseUrl(value);
  return URL.canParse(normalized) ? undefined : 'Enter a valid URL';
}

export function parseModelIds(input: string): string[] {
  const parsed = input
    .split(/[\n,]/)
    .map((modelId) => modelId.trim())
    .filter(Boolean);
  return Array.from(new Set(parsed));
}

export interface ModelDefinition {
  id: string;
  name: string;
  api: 'openai-completions';
  reasoning: boolean;
  input: Array<'text'>;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export function buildModelDefinition(modelId: string): ModelDefinition {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
