// Top-level configuration loader (Issue #11).
//
// Combines three input sources, in precedence order from highest to
// lowest:
//
//   1. Environment variables (`TURBOCHARGER_*`)
//   2. Config file (path from `TURBOCHARGER_CONFIG`)
//   3. Hard-coded defaults (just `port = 11435`)
//
// Per ADR-0024 the merged shape is validated by `TurbochargerConfigSchema`
// from schema.ts. Validation errors are aggregated — operators see
// every problem at once rather than fixing one, restarting, and
// hitting the next.
//
// The function returns a `LoadedConfig` that splits the validated
// shape back into the call signature `startServer(appConfig, deps)`
// already expects, so server.ts does not need to learn the new
// composite shape. The split is mechanical (AppConfig fields go to
// `appConfig`, sub-configs go to `deps`).

import type {
  AnswerMode,
  AppConfig,
  ChorusConfig,
  EscalationConfig,
  OrchestratorConfig,
  TransparencyConfig,
} from '../types.js';

import { DEFAULT_PORT, parseEnvVars } from './env.js';
import { parseConfigFile } from './file.js';
import { TurbochargerConfigSchema } from './schema.js';

/**
 * The split-out result of `loadConfig`. Mirrors the (config, deps)
 * pair `startServer` consumes, so the entry point can pass through.
 *
 * Note on `orchestratorConfig`: the loader can populate every field
 * of `OrchestratorConfig` except `llmCritic`, which is a `{run, config}`
 * pair where `run` is a callable that cannot come from a YAML file.
 * Operators who need an LLM critic build the runnable callable in
 * code and merge it onto `loadedConfig.orchestratorConfig` before
 * passing it to `startServer`. The loader exposes the static side
 * (threshold, weights, greyBand) — which is everything the schema
 * can validate.
 */
export type LoadedOrchestratorConfig = Omit<OrchestratorConfig, 'llmCritic'>;

export interface LoadedConfig {
  readonly appConfig: AppConfig;
  readonly defaultAnswerMode?: AnswerMode;
  readonly orchestratorConfig?: LoadedOrchestratorConfig;
  readonly escalationConfig?: EscalationConfig;
  readonly chorusConfig?: ChorusConfig;
  readonly transparencyConfig?: TransparencyConfig;
}

/**
 * Load and validate the full turbocharger configuration.
 *
 * Throws an Error with an aggregated, actionable message when the
 * merged config is invalid. The Error's `.message` includes every
 * Zod issue with its dotted path, so operators can fix all of them
 * in one edit.
 *
 * @param env Process environment. Defaulted from process.env so
 *   real callers do not pass anything; tests inject a frozen object.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const fromFile = readFileFromEnv(env);
  const fromEnv = parseEnvVars(env);

  const merged = deepMerge(deepMerge({ port: DEFAULT_PORT }, fromFile), fromEnv);

  const result = TurbochargerConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(formatValidationError(result.error));
  }

  const validated = result.data;
  const appConfig: AppConfig = {
    port: validated.port,
    downstreamBaseUrl: validated.downstreamBaseUrl.replace(/\/+$/, ''),
    ...(validated.downstreamApiKey !== undefined
      ? { downstreamApiKey: validated.downstreamApiKey }
      : {}),
  };

  return {
    appConfig,
    ...(validated.answerMode !== undefined ? { defaultAnswerMode: validated.answerMode } : {}),
    ...(validated.orchestrator !== undefined
      ? { orchestratorConfig: mapOrchestratorConfig(validated.orchestrator) }
      : {}),
    ...(validated.escalation !== undefined
      ? { escalationConfig: mapEscalationConfig(validated.escalation) }
      : {}),
    ...(validated.chorus !== undefined
      ? { chorusConfig: mapChorusConfig(validated.chorus) }
      : {}),
    ...(validated.transparency !== undefined
      ? { transparencyConfig: validated.transparency }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Sub-config mappers
// ---------------------------------------------------------------------------

// These exist so optional fields propagate via conditional spread
// rather than `T | undefined` literals, which the project's
// `exactOptionalPropertyTypes: true` rejects when the underlying
// interface has plain `T?:`. The mappers also drop fields the loader
// cannot meaningfully populate (specifically OrchestratorConfig's
// `llmCritic` which carries a runtime callable).

function mapOrchestratorConfig(input: {
  readonly threshold: number;
  readonly weights: Record<string, number>;
  readonly greyBand: readonly [number, number];
}): LoadedOrchestratorConfig {
  return {
    threshold: input.threshold,
    weights: input.weights as LoadedOrchestratorConfig['weights'],
    greyBand: input.greyBand,
  };
}

function mapEscalationConfig(input: {
  readonly mode: 'ladder' | 'max';
  readonly ladder: readonly string[];
  readonly maxModel?: string;
  readonly maxDepth: number;
}): EscalationConfig {
  return {
    mode: input.mode,
    ladder: input.ladder,
    maxDepth: input.maxDepth,
    ...(input.maxModel !== undefined ? { maxModel: input.maxModel } : {}),
  };
}

function mapChorusConfig(input: {
  readonly endpoint: string;
  readonly timeoutMs?: number;
}): ChorusConfig {
  return {
    endpoint: input.endpoint,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readFileFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const path = env.TURBOCHARGER_CONFIG?.trim();
  if (path === undefined || path === '') return {};
  const parsed = parseConfigFile(path);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Config file ${path} must contain a top-level object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}.`,
    );
  }
  // YAML configs traditionally wrap settings in a `turbocharger:` key
  // (see examples/standalone-config.example.yaml). Unwrap that
  // convention transparently — operators should not have to know
  // whether the loader expects wrapped or flat shape.
  const obj = parsed as Record<string, unknown>;
  if (
    Object.keys(obj).length === 1 &&
    'turbocharger' in obj &&
    typeof obj['turbocharger'] === 'object' &&
    obj['turbocharger'] !== null &&
    !Array.isArray(obj['turbocharger'])
  ) {
    return normalizeFileShape(obj['turbocharger'] as Record<string, unknown>);
  }
  return normalizeFileShape(obj);
}

/**
 * Translate the YAML/JSON snake_case shape (per the examples files)
 * into the camelCase shape the Zod schema expects. The schema is the
 * source of truth; this function exists so operators can write
 * `downstream_base_url` in a YAML and have it land at
 * `downstreamBaseUrl` in the validated object.
 *
 * Conversion is recursive: nested objects are translated too. Keys
 * that already look camelCase are passed through unchanged so a
 * mixed-case file (e.g. partly hand-written, partly tool-generated)
 * still works.
 */
function normalizeFileShape(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const camelKey = snakeToCamel(key);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[camelKey] = normalizeFileShape(value as Record<string, unknown>);
    } else {
      out[camelKey] = value;
    }
  }
  return out;
}

function snakeToCamel(input: string): string {
  return input.replace(/_([a-zA-Z])/g, (_, ch: string) => ch.toUpperCase());
}

/**
 * Recursively merge two plain-object trees. Right-hand wins on
 * conflicts. Arrays and primitives on the right replace whatever was
 * on the left at the same path — this matches the precedence
 * semantics (env replaces file) intuitively.
 */
function deepMerge(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const leftValue = out[key];
    if (
      leftValue !== null &&
      typeof leftValue === 'object' &&
      !Array.isArray(leftValue) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(leftValue as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Render a Zod ZodError as a multi-line, operator-friendly message.
 * Every issue gets its full dotted path plus the schema's message
 * text. The brief's "actionable" rule applies: anyone reading this
 * should know exactly which field to fix.
 */
function formatValidationError(error: import('zod').ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `Configuration is invalid:\n${lines.join('\n')}`;
}
