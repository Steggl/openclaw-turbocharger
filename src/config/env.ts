// Environment-based config loader for issue #2.
//
// Deliberately separate from src/config/load.ts and src/config/schema.ts: those
// are reserved for the Zod-schema-backed file-and-env loader from issue #11.
// Pre-empting that work here would either duplicate the schema or force #11 to
// rewrite this file. Once #11 lands, this loader can either be replaced or
// kept as a thin shim that delegates to the schema-validated loader.

import type { AppConfig } from '../types.js';

/** Default sidecar port. Chosen to sit one above Ollama's 11434. */
const DEFAULT_PORT = 11435;

/**
 * Read sidecar configuration from environment variables. Fails fast with
 * an actionable error message (per brief §8: "Error messages include
 * remediation hints") when required values are missing or malformed.
 *
 * Recognized variables:
 * - `TURBO_DOWNSTREAM_BASE_URL` (required) — OpenAI-compatible base URL.
 * - `TURBO_DOWNSTREAM_API_KEY` (optional) — bearer token forwarded only
 *   when the client request lacks its own `Authorization` header.
 * - `TURBO_PORT` (optional, default 11435) — TCP port to listen on.
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const downstream = env.TURBO_DOWNSTREAM_BASE_URL?.trim();
  if (!downstream) {
    throw new Error(
      'TURBO_DOWNSTREAM_BASE_URL is required. Set it to an OpenAI-compatible base URL ' +
        '(e.g. http://localhost:11434/v1 for Ollama, https://api.openai.com/v1 for OpenAI). ' +
        'The sidecar appends /chat/completions when forwarding.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(downstream);
  } catch {
    throw new Error(
      `TURBO_DOWNSTREAM_BASE_URL is not a valid URL: ${JSON.stringify(downstream)}. ` +
        'Expected a fully-qualified http(s) URL such as http://localhost:11434/v1.',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `TURBO_DOWNSTREAM_BASE_URL must use http or https, got ${parsed.protocol.replace(':', '')}.`,
    );
  }

  const portRaw = env.TURBO_PORT?.trim();
  let port = DEFAULT_PORT;
  if (portRaw !== undefined && portRaw !== '') {
    const n = Number(portRaw);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(
        `TURBO_PORT must be an integer in 1..65535 if set, got ${JSON.stringify(portRaw)}.`,
      );
    }
    port = n;
  }

  const apiKey = env.TURBO_DOWNSTREAM_API_KEY?.trim();
  const downstreamBaseUrl = downstream.replace(/\/+$/, '');

  return {
    port,
    downstreamBaseUrl,
    ...(apiKey ? { downstreamApiKey: apiKey } : {}),
  };
}
