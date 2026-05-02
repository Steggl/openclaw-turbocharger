// Locale resolution helper. Resolves user-supplied locale strings (which
// may carry BCP-47 region/script subtags or use the underscore convention,
// e.g. `de-DE`, `de_DE`) down to the bucket that the caller's locale-keyed
// table actually contains.
//
// The transparency layer has its own resolvers (`resolveBannerLocale`,
// `resolveCardLocale`) that pre-date this helper and use a hard-coded
// `de` mapping. They are intentionally not migrated here — see ADR-0026
// for the scope decision. New locale-keyed tables should reach for this
// helper instead of growing another bespoke resolver.
//
// Algorithm: case-insensitive prefix match against the entries of
// `allowed`. The longest-prefix winner is chosen so a future caller can
// list `pt-BR` ahead of `pt` and have Brazilian Portuguese take
// precedence over a Portuguese fallback when the input is `pt-BR-x-foo`.
// In practice the current callers only declare bare language codes, so
// the longest-prefix tie-breaking is dormant but free.
//
// Returns `fallback` when no entry of `allowed` is a prefix of the input.

/**
 * Resolve a user-supplied locale string against a closed list of buckets.
 *
 * @param input    Locale string from the request, e.g. `'de-DE'`,
 *                 `'de_DE'`, `'DE'`, `'fr-CA'`, `''`, or `undefined`.
 * @param allowed  The buckets the caller actually has data for, e.g.
 *                 `['en', 'de'] as const`.
 * @param fallback The bucket to return when no entry of `allowed` is a
 *                 prefix of `input`.
 *
 * @returns One of the entries of `allowed`, or `fallback` if nothing
 *          matched.
 */
export function resolveLocale<L extends string>(
  input: string | undefined,
  allowed: readonly L[],
  fallback: L,
): L {
  if (input === undefined || input.length === 0) return fallback;
  const lower = input.toLowerCase();

  // Iterate longest-first so a caller listing `['pt-BR', 'pt']` would
  // match `'pt-BR-x-foo'` against `'pt-BR'` rather than `'pt'`. With
  // the current callers (`['en', 'de']`) the order is irrelevant.
  const sorted = [...allowed].sort((a, b) => b.length - a.length);

  for (const candidate of sorted) {
    const cl = candidate.toLowerCase();
    if (lower === cl || lower.startsWith(`${cl}-`) || lower.startsWith(`${cl}_`)) {
      return candidate;
    }
  }

  return fallback;
}
