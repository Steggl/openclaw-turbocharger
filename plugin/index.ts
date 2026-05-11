import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from 'openclaw/plugin-sdk/plugin-entry';
import {
  DEFAULT_API_KEY,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_REFS,
  PROVIDER_ID,
  buildModelDefinition,
  normalizeBaseUrl,
  parseModelIds,
  validateBaseUrl,
} from './wizard.js';

export default definePluginEntry({
  id: PROVIDER_ID,
  name: 'openclaw-turbocharger',
  description: 'Reactive escalation sidecar for OpenAI-compatible providers',
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: 'openclaw-turbocharger',
      docsPath: '/providers/models',
      auth: [
        {
          id: 'local',
          label: 'Local sidecar',
          hint: 'Configure base URL + models for the openclaw-turbocharger sidecar',
          kind: 'custom',
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const baseUrlInput = await ctx.prompter.text({
              message: 'Sidecar base URL',
              initialValue: DEFAULT_BASE_URL,
              validate: validateBaseUrl,
            });

            const apiKeyInput = await ctx.prompter.text({
              message: 'API key (optional, press enter to skip)',
              initialValue: '',
            });

            const modelInput = await ctx.prompter.text({
              message: 'Model IDs (comma-separated)',
              initialValue: DEFAULT_MODEL_REFS.join(', '),
              validate: (value: string) =>
                parseModelIds(value).length > 0 ? undefined : 'Enter at least one model id',
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
                    type: 'token',
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
                      api: 'openai-completions',
                      authHeader: hasRealKey,
                      models: modelIds.map((modelId) => buildModelDefinition(modelId)),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(
                      modelIds.map((modelId) => [`${PROVIDER_ID}/${modelId}`, {}]),
                    ),
                  },
                },
              },
              defaultModel: defaultModelRef,
              notes: [
                'Start the openclaw-turbocharger sidecar before using these models.',
                'Sidecar serves /v1/chat/completions; base URL must include /v1.',
                "Configure ladder/max escalation in the sidecar's config.yaml; see https://github.com/Steggl/openclaw-turbocharger#configuration.",
                'X-Turbocharger-* response headers describe escalation decisions and are visible in OpenClaw logs.',
              ],
            };
          },
        },
      ],
      wizard: {
        setup: {
          choiceId: PROVIDER_ID,
          choiceLabel: 'openclaw-turbocharger',
          choiceHint: 'Reactive escalation sidecar',
          methodId: 'local',
        },
      },
    });
  },
});
