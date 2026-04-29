// Environment-variable based config parsing.
//
// Per ADR-0024 the env-var prefix is `TURBOCHARGER_`. Nested fields
// use `__` (double underscore) as the path separator; arrays of
// primitives use comma separation:
//
//   TURBOCHARGER_PORT=11500
//   TURBOCHARGER_DOWNSTREAM_BASE_URL=http://localhost:11434/v1
//   TURBOCHARGER_DOWNSTREAM_API_KEY=sk-...
//   TURBOCHARGER_ANSWER_MODE=single
//   TURBOCHARGER_ORCHESTRATOR__THRESHOLD=0.6
//   TURBOCHARGER_ORCHESTRATOR__GREY_BAND=0.3,0.6
//   TURBOCHARGER_ORCHESTRATOR__WEIGHTS__REFUSAL=1.0
//   TURBOCHARGER_ORCHESTRATOR__WEIGHTS__TRUNCATION=1.0
//   TURBOCHARGER_ESCALATION__MODE=ladder
//   TURBOCHARGER_ESCALATION__LADDER=ollama/qwen2.5:7b,anthropic/claude-haiku-4-5
//   TURBOCHARGER_ESCALATION__MAX_MODEL=anthropic/claude-opus-4-7
//   TURBOCHARGER_ESCALATION__MAX_DEPTH=2
//   TURBOCHARGER_CHORUS__ENDPOINT=http://localhost:11436/v1/chat/completions
//   TURBOCHARGER_CHORUS__TIMEOUT_MS=90000
//   TURBOCHARGER_TRANSPARENCY__MODE=banner
//   TURBOCHARGER_CONFIG=/etc/turbocharger.yaml
//
// All values come in as strings; this module coerces them into the
// shapes the Zod schemas expect (numbers, booleans, arrays, nested
// objects). It does not validate — that is the schema's job in
// load.ts. The output is a partial, possibly nonsensical object; the
// validator catches real errors with full path context.
//
// The previous `loadEnvConfig` is preserved as a thin shim so
// existing callers keep working until the server.ts entry point is
// rewritten on top of `loadConfig`.

import type { AppConfig } from '../types.js';

const ENV_PREFIX = 'TURBOCHARGER_';
const PATH_SEPARATOR = '__';
const ARRAY_SEPARATOR = ',';

/** Default sidecar port. Chosen to sit one above Ollama's 11434. */
export const DEFAULT_PORT = 11435;

/**
 * Parse all `TURBOCHARGER_*` environment variables into a partial
 * config shape. The returned value is intentionally `unknown`-typed:
 * it has not been validated yet; the caller passes it through the
 * Zod schema in load.ts.
 */
export function parseEnvVars(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX)) continue;
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue;

    const stripped = key.slice(ENV_PREFIX.length);

    // TURBOCHARGER_CONFIG is a meta-variable consumed by the loader,
    // not part of the config surface itself. Skip it here so it
    // does not become an unknown-field error.
    if (stripped === 'CONFIG') continue;

    const path = envKeyToPath(stripped);
    if (path === null) continue;

    setNested(result, path, coerceValue(stripped, trimmed));
  }

  return result;
}

/**
 * Backwards-compatible shim. The original entry point used by
 * server.ts predates Issue #11 and exposes only the AppConfig
 * fields. It is kept here so the existing default
 * `startServer(config = loadEnvConfig())` signature continues to
 * work; new code paths should call `loadConfig` from load.ts
 * instead.
 *
 * Per ADR-0024 the env-var prefix changed from `TURBO_` to
 * `TURBOCHARGER_` — this is a hard rename, no alias is recognised.
 * Operators with stale env vars get a clear "is required" error.
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const downstream = env.TURBOCHARGER_DOWNSTREAM_BASE_URL?.trim();
  if (!downstream) {
    throw new Error(
      'TURBOCHARGER_DOWNSTREAM_BASE_URL is required. Set it to an OpenAI-compatible base URL ' +
        '(e.g. http://localhost:11434/v1 for Ollama, https://api.openai.com/v1 for OpenAI). ' +
        'The sidecar appends /chat/completions when forwarding.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(downstream);
  } catch {
    throw new Error(
      `TURBOCHARGER_DOWNSTREAM_BASE_URL is not a valid URL: ${JSON.stringify(downstream)}. ` +
        'Expected a fully-qualified http(s) URL such as http://localhost:11434/v1.',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `TURBOCHARGER_DOWNSTREAM_BASE_URL must use http or https, got ${parsed.protocol.replace(':', '')}.`,
    );
  }

  const portRaw = env.TURBOCHARGER_PORT?.trim();
  let port = DEFAULT_PORT;
  if (portRaw !== undefined && portRaw !== '') {
    const n = Number(portRaw);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(
        `TURBOCHARGER_PORT must be an integer in 1..65535 if set, got ${JSON.stringify(portRaw)}.`,
      );
    }
    port = n;
  }

  const apiKey = env.TURBOCHARGER_DOWNSTREAM_API_KEY?.trim();
  const downstreamBaseUrl = downstream.replace(/\/+$/, '');

  return {
    port,
    downstreamBaseUrl,
    ...(apiKey ? { downstreamApiKey: apiKey } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Translate the env-var name (already stripped of the `TURBOCHARGER_`
 * prefix) into a dotted path of camelCase keys. Returns `null` when
 * the name is not a valid path (empty, malformed).
 *
 * Examples (input → output):
 *   PORT                                  → ['port']
 *   DOWNSTREAM_BASE_URL                   → ['downstreamBaseUrl']
 *   ANSWER_MODE                           → ['answerMode']
 *   ORCHESTRATOR__THRESHOLD               → ['orchestrator', 'threshold']
 *   ORCHESTRATOR__WEIGHTS__REFUSAL        → ['orchestrator', 'weights', 'refusal']
 *   ESCALATION__LADDER                    → ['escalation', 'ladder']
 *   ESCALATION__MAX_DEPTH                 → ['escalation', 'maxDepth']
 *   TRANSPARENCY__MODE                    → ['transparency', 'mode']
 */
function envKeyToPath(stripped: string): string[] | null {
  if (stripped.length === 0) return null;
  const segments = stripped.split(PATH_SEPARATOR);
  const path: string[] = [];
  for (const seg of segments) {
    if (seg.length === 0) return null;
    path.push(snakeToCamel(seg));
  }
  return path;
}

function snakeToCamel(input: string): string {
  const lower = input.toLowerCase();
  return lower.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/**
 * Set a nested field in `target`, creating intermediate objects as
 * needed. Path is the camelCase key sequence from envKeyToPath.
 */
function setNested(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const existing = cursor[key];
    if (existing === undefined || typeof existing !== 'object' || existing === null) {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    } else {
      cursor = existing as Record<string, unknown>;
    }
  }
  cursor[path[path.length - 1]!] = value;
}

/**
 * Coerce a raw env-var string into the shape the schema expects.
 * The path is used to apply context-specific coercion: array fields
 * (ladder, greyBand) split on commas; numeric fields try
 * `Number.parseFloat`; everything else stays a string.
 *
 * Coercion is best-effort: when in doubt the value is returned as a
 * string and the Zod validator emits a clear type error in load.ts.
 */
function coerceValue(stripped: string, raw: string): unknown {
  // Array fields, split on commas. Listing them explicitly is more
  // robust than guessing from the value shape (a single-string ladder
  // is a legal config too, just unusual).
  const arrayPaths = new Set(['ESCALATION__LADDER', 'ORCHESTRATOR__GREY_BAND']);
  if (arrayPaths.has(stripped)) {
    const parts = raw
      .split(ARRAY_SEPARATOR)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (stripped === 'ORCHESTRATOR__GREY_BAND') {
      return parts.map(maybeNumber);
    }
    return parts;
  }

  return maybeNumber(raw);
}

/**
 * Best-effort numeric and boolean coercion. Returns the parsed value
 * when the input matches a recognised primitive form; otherwise
 * returns the string unchanged so the validator can produce a typed
 * error.
 */
function maybeNumber(raw: string): number | string | boolean {
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;

  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}
