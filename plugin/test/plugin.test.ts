import { describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: <T>(entry: T): T => entry,
}));

interface RegisteredProvider {
  id: string;
  label: string;
  docsPath: string;
  auth: Array<{
    id: string;
    label: string;
    kind: string;
    run: (...args: unknown[]) => unknown;
  }>;
  wizard: {
    setup: {
      choiceId: string;
      methodId: string;
    };
  };
}

interface MockApi {
  registerProvider: (provider: RegisteredProvider) => void;
}

async function loadPlugin() {
  const mod = await import('../index.js');
  return mod.default as unknown as {
    id: string;
    name: string;
    description: string;
    register: (api: MockApi) => void;
  };
}

function captureProvider() {
  const calls: RegisteredProvider[] = [];
  const api: MockApi = {
    registerProvider: (provider) => calls.push(provider),
  };
  return { calls, api };
}

describe('plugin entry', () => {
  it('exports a plugin entry with the expected id, name, and description', async () => {
    const plugin = await loadPlugin();
    expect(plugin.id).toBe('openclaw-turbocharger');
    expect(plugin.name).toBe('openclaw-turbocharger');
    expect(plugin.description).toBe('Reactive escalation sidecar for OpenAI-compatible providers');
  });

  it('registers exactly one Provider when register() is invoked', async () => {
    const plugin = await loadPlugin();
    const { calls, api } = captureProvider();
    plugin.register(api);
    expect(calls).toHaveLength(1);
  });

  it('registers a Provider with the expected top-level shape', async () => {
    const plugin = await loadPlugin();
    const { calls, api } = captureProvider();
    plugin.register(api);
    const provider = calls[0];
    expect(provider.id).toBe('openclaw-turbocharger');
    expect(provider.label).toBe('openclaw-turbocharger');
    expect(provider.docsPath).toBe('/providers/models');
    expect(provider.auth).toHaveLength(1);
    expect(provider.wizard).toBeDefined();
    expect(provider.wizard.setup.choiceId).toBe('openclaw-turbocharger');
    expect(provider.wizard.setup.methodId).toBe('local');
  });

  it("registers a Provider whose auth[0] is a runnable 'custom' method", async () => {
    const plugin = await loadPlugin();
    const { calls, api } = captureProvider();
    plugin.register(api);
    const auth = calls[0].auth[0];
    expect(auth.id).toBe('local');
    expect(auth.kind).toBe('custom');
    expect(typeof auth.run).toBe('function');
  });
});
