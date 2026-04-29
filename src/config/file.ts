// File-based config parser (Issue #11).
//
// Reads a YAML or JSON file from disk and returns the parsed shape
// without validating it — that is the schema's job in load.ts.
// File extension decides parser: `.yaml`/`.yml` → YAML, `.json` →
// JSON. Anything else is rejected with an actionable error.
//
// Per ADR-0024, file syntax errors propagate with the file path
// included in the message: an operator who edited the wrong file
// should not have to guess where a stray colon went.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import { parse as parseYaml } from 'yaml';

/**
 * Read and parse a config file. Returns the raw parsed object.
 * Throws an Error with an actionable message when the file is
 * missing, has an unsupported extension, or fails to parse.
 *
 * The result is `unknown` because the file is operator-supplied:
 * the validator in load.ts is responsible for confirming shape.
 */
export function parseConfigFile(path: string): unknown {
  const ext = extname(path).toLowerCase();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to read config file at ${path}: ${detail}. ` +
        'Set TURBOCHARGER_CONFIG to an existing readable path, or unset it to use environment variables only.',
    );
  }

  if (ext === '.yaml' || ext === '.yml') {
    try {
      return parseYaml(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse YAML config at ${path}: ${detail}`);
    }
  }

  if (ext === '.json') {
    try {
      return JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse JSON config at ${path}: ${detail}`);
    }
  }

  throw new Error(
    `Config file ${path} has unsupported extension ${ext.length > 0 ? JSON.stringify(ext) : '(none)'}. ` +
      'Use .yaml, .yml, or .json.',
  );
}
