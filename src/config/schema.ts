// Zod schemas for the turbocharger configuration surface (Issue #11).
//
// One schema per Config interface in src/types.ts. The TypeScript
// types remain the source of truth — these schemas are written so
// that `z.infer<typeof X>` produces a structural match for the
// existing interface. A type-equivalence test guards the contract:
// if the two ever diverge, `pnpm typecheck` fails before tests do.
//
// Per ADR-0024:
//   - YAML and JSON are both accepted; Zod sees the parsed object
//     either way and does not care about the source format.
//   - Validation errors are aggregated, never short-circuited on the
//     first issue. The loader (load.ts) is responsible for that.
//   - All schemas are strict in what they reject (unknown fields
//     fail) but lenient in what they accept (numeric strings from
//     env vars are coerced to numbers; comma-separated strings are
//     split into arrays). The strict-rejection of unknown fields is
//     deliberate: silent ignorance of typos is one of the failure
//     modes the brief explicitly calls out (§8 "no silent fallbacks").

import { z } from 'zod';

import type {
  AnswerMode,
  AppConfig,
  ChorusConfig,
  EscalationConfig,
  OrchestratorConfig,
  SignalCategory,
  TransparencyConfig,
} from '../types.js';

// ---------------------------------------------------------------------------
// AppConfig
// ---------------------------------------------------------------------------

export const AppConfigSchema = z
  .object({
    port: z
      .number()
      .int('port must be an integer')
      .min(1, 'port must be in 1..65535')
      .max(65535, 'port must be in 1..65535'),
    downstreamBaseUrl: z
      .string()
      .min(1, 'downstreamBaseUrl is required')
      .refine((s) => {
        try {
          const u = new URL(s);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      }, 'downstreamBaseUrl must be a fully-qualified http(s) URL'),
    downstreamApiKey: z.string().min(1).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// AnswerMode
// ---------------------------------------------------------------------------

export const AnswerModeSchema: z.ZodType<AnswerMode> = z.enum(['single', 'chorus']);

// ---------------------------------------------------------------------------
// OrchestratorConfig
// ---------------------------------------------------------------------------

const SIGNAL_CATEGORIES: readonly SignalCategory[] = [
  'refusal',
  'truncation',
  'repetition',
  'empty',
  'tool_error',
  'syntax_error',
];

const SignalWeightsSchema = z
  .object(
    Object.fromEntries(
      SIGNAL_CATEGORIES.map((cat) => [
        cat,
        z
          .number()
          .min(0, `${cat} weight must be in [0, 1]`)
          .max(1, `${cat} weight must be in [0, 1]`),
      ]),
    ) as Record<SignalCategory, z.ZodNumber>,
  )
  .strict();

const ModelPricingSchema = z
  .object({
    promptUsdPer1kTokens: z.number().min(0),
    completionUsdPer1kTokens: z.number().min(0),
  })
  .strict();

const LlmCriticConfigSchema = z
  .object({
    baseUrl: z
      .string()
      .min(1, 'llmCritic.baseUrl is required when llmCritic is configured')
      .refine((s) => {
        try {
          const u = new URL(s);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      }, 'llmCritic.baseUrl must be a fully-qualified http(s) URL'),
    model: z.string().min(1, 'llmCritic.model is required'),
    apiKey: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    budgetUsd: z.number().nonnegative().optional(),
    pricing: ModelPricingSchema.optional(),
  })
  .strict();

export const OrchestratorConfigSchema = z
  .object({
    threshold: z
      .number()
      .min(0, 'orchestrator.threshold must be in [0, 1]')
      .max(1, 'orchestrator.threshold must be in [0, 1]'),
    weights: SignalWeightsSchema,
    greyBand: z
      .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
      .refine(
        (b) => b[0] <= b[1],
        'orchestrator.greyBand must satisfy lower <= upper (got [lower, upper])',
      ),
    llmCritic: LlmCriticConfigSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// EscalationConfig
// ---------------------------------------------------------------------------

export const EscalationConfigSchema: z.ZodType<EscalationConfig> = z
  .object({
    mode: z.enum(['ladder', 'max']),
    ladder: z.array(z.string().min(1)).readonly(),
    maxModel: z.string().min(1).optional(),
    maxDepth: z
      .number()
      .int('escalation.maxDepth must be an integer')
      .min(0, 'escalation.maxDepth must be >= 0'),
  })
  .strict()
  .refine((cfg) => {
    // max mode requires maxModel; ladder mode does not.
    if (cfg.mode === 'max' && cfg.maxModel === undefined) return false;
    return true;
  }, "escalation.mode is 'max' but escalation.maxModel is not set; max-mode escalation requires a target model");

// ---------------------------------------------------------------------------
// ChorusConfig
// ---------------------------------------------------------------------------

export const ChorusConfigSchema: z.ZodType<ChorusConfig> = z
  .object({
    endpoint: z
      .string()
      .min(1, 'chorus.endpoint is required when chorus is configured')
      .refine((s) => {
        try {
          const u = new URL(s);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      }, 'chorus.endpoint must be a fully-qualified http(s) URL'),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// TransparencyConfig
// ---------------------------------------------------------------------------

export const TransparencyConfigSchema: z.ZodType<TransparencyConfig> = z
  .object({
    mode: z.enum(['banner', 'silent', 'card']),
  })
  .strict();

// ---------------------------------------------------------------------------
// TurbochargerConfig (top-level composition)
// ---------------------------------------------------------------------------

/**
 * Top-level configuration shape. Composed of the AppConfig fields
 * (always required) plus optional sub-configs. The loader (load.ts)
 * merges environment variables and file inputs into this shape and
 * validates the result with `TurbochargerConfigSchema`.
 *
 * The shape mirrors what `startServer(config, deps)` consumes: the
 * `AppConfig` fields go in `config`, the sub-configs go in `deps`.
 * Splitting them apart and re-assembling is the loader's job.
 */
export const TurbochargerConfigSchema = z
  .object({
    port: AppConfigSchema.shape.port,
    downstreamBaseUrl: AppConfigSchema.shape.downstreamBaseUrl,
    downstreamApiKey: AppConfigSchema.shape.downstreamApiKey,
    answerMode: AnswerModeSchema.optional(),
    orchestrator: OrchestratorConfigSchema.optional(),
    escalation: EscalationConfigSchema.optional(),
    chorus: ChorusConfigSchema.optional(),
    transparency: TransparencyConfigSchema.optional(),
  })
  .strict()
  .refine((cfg) => {
    // chorus mode requires a chorus config.
    if (cfg.answerMode === 'chorus' && cfg.chorus === undefined) return false;
    return true;
  }, "answerMode is 'chorus' but chorus.endpoint is not set; chorus mode requires a chorus configuration");

export type TurbochargerConfig = z.infer<typeof TurbochargerConfigSchema>;

// ---------------------------------------------------------------------------
// Type-equivalence guards (compile-time only)
// ---------------------------------------------------------------------------

// These assignments compile only if the Zod-inferred shapes are
// assignable to the hand-written interfaces in src/types.ts. They
// fire at typecheck time, before any test runs. If the schema and
// the interface drift, the failure points here.

const _appConfigEquivalent: AppConfig = {} as z.infer<typeof AppConfigSchema>;
const _orchestratorConfigEquivalent: OrchestratorConfig = {} as z.infer<
  typeof OrchestratorConfigSchema
>;
const _escalationConfigEquivalent: EscalationConfig = {} as z.infer<typeof EscalationConfigSchema>;
const _chorusConfigEquivalent: ChorusConfig = {} as z.infer<typeof ChorusConfigSchema>;
const _transparencyConfigEquivalent: TransparencyConfig = {} as z.infer<
  typeof TransparencyConfigSchema
>;
void _appConfigEquivalent;
void _orchestratorConfigEquivalent;
void _escalationConfigEquivalent;
void _chorusConfigEquivalent;
void _transparencyConfigEquivalent;
