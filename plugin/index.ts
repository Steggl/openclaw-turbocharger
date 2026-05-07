import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk";

const PROVIDER_ID = "openclaw-turbocharger";
const DEFAULT_BASE_URL = "http://localhost:11435/v1";
const DEFAULT_API_KEY = "n/a";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;

const DEFAULT_MODEL_REFS = [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-7",
  "qwen2.5:7b",
] as const;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  let normalized = trimmed;
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized.endsWith("/v1")) {
    normalized = `${normalized}/v1`;
  }
  return normalized;
}

function validateBaseUrl(value: string): string | undefined {
  const normalized = normalizeBaseUrl(value);
  return URL.canParse(normalized) ? undefined : "Enter a valid URL";
}

function parseModelIds(input: string): string[] {
  const parsed = input
    .split(/[\n,]/)
    .map((modelId) => modelId.trim())
    .filter(Boolean);
  return Array.from(new Set(parsed));
}

function buildModelDefinition(modelId: string) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions" as const,
    reasoning: false,
    input: ["text"] as Array<"text">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "openclaw-turbocharger",
  description: "Reactive escalation sidecar for OpenAI-compatible providers",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "openclaw-turbocharger",
      docsPath: "/providers/models",
      auth: [
        {
          id: "local",
          label: "Local sidecar",
          hint: "Configure base URL + models for the openclaw-turbocharger sidecar",
          kind: "custom",
          run: async (
            ctx: ProviderAuthContext,
          ): Promise<ProviderAuthResult> => {
            const baseUrlInput = await ctx.prompter.text({
              message: "Sidecar base URL",
              initialValue: DEFAULT_BASE_URL,
              validate: validateBaseUrl,
            });

            const apiKeyInput = await ctx.prompter.text({
              message: "API key (optional, press enter to skip)",
              initialValue: "",
            });

            const modelInput = await ctx.prompter.text({
              message: "Model IDs (comma-separated)",
              initialValue: DEFAULT_MODEL_REFS.join(", "),
              validate: (value: string) =>
                parseModelIds(value).length > 0
                  ? undefined
                  : "Enter at least one model id",
            });

            const baseUrl = normalizeBaseUrl(baseUrlInput);
            const trimmedKey = apiKeyInput.trim();
            const apiKey = trimmedKey || DEFAULT_API_KEY;
            const hasRealKey = apiKey !== DEFAULT_API_KEY;
            const modelIds = parseModelIds(modelInput);
            const defaultModelId = modelIds[0] ?? DEFAULT_MODEL_REFS[0];
            const defaultModelRef = `${PROVIDER_ID}/${defaultModelId}`;

            return {
              profiles: [
                {
                  profileId: `${PROVIDER_ID}:local`,
                  credential: {
                    type: "token",
                    provider: PROVIDER_ID,
                    token: apiKey,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl,
                      apiKey,
                      api: "openai-completions",
                      authHeader: hasRealKey,
                      models: modelIds.map((modelId) =>
                        buildModelDefinition(modelId),
                      ),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(
                      modelIds.map((modelId) => [
                        `${PROVIDER_ID}/${modelId}`,
                        {},
                      ]),
                    ),
                  },
                },
              },
              defaultModel: defaultModelRef,
              notes: [
                "Start the openclaw-turbocharger sidecar before using these models.",
                "Sidecar serves /v1/chat/completions; base URL must include /v1.",
                "Configure ladder/max escalation in the sidecar's config.yaml; see https://github.com/Steggl/openclaw-turbocharger#configuration.",
                "X-Turbocharger-* response headers describe escalation decisions and are visible in OpenClaw logs.",
              ],
            };
          },
        },
      ],
      wizard: {
        setup: {
          choiceId: PROVIDER_ID,
          choiceLabel: "openclaw-turbocharger",
          choiceHint: "Reactive escalation sidecar",
          methodId: "local",
        },
      },
    });
  },
});
