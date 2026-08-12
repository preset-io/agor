/**
 * Stable, provider-agnostic classifications for errors that are safe to show
 * in durable conversation state. The provider response itself must never be
 * persisted when one of these classifications matches.
 */

export const PROVIDER_CREDIT_EXHAUSTED_ERROR_KIND = 'provider_credit_exhausted' as const;
export const PROVIDER_CREDIT_EXHAUSTED_ERROR_CODE = 'PROVIDER_CREDIT_EXHAUSTED' as const;
export const PROVIDER_CREDIT_EXHAUSTED_MESSAGE =
  'The model provider has no available credit or quota for this request.';

export type ProviderErrorKind = typeof PROVIDER_CREDIT_EXHAUSTED_ERROR_KIND;
export type ProviderErrorCode = typeof PROVIDER_CREDIT_EXHAUSTED_ERROR_CODE;

export interface ProviderErrorClassification {
  kind: ProviderErrorKind;
  code: ProviderErrorCode;
}

const CREDIT_EXHAUSTION_PATTERNS = [
  /\bcredit\s+balance\b[\s\S]{0,48}\btoo\s+low\b/i,
  /\binsufficient[\s_-]+(?:credit|credits|funds|quota)\b/i,
  /\b(?:credit|credits|funds|quota|balance)\b[\s\S]{0,32}\b(?:exhausted|depleted|used\s+up)\b/i,
  /\b(?:credit|credits|quota)\s+(?:limit\s+)?exceeded\b/i,
  /\b(?:exceeded|reached)\s+(?:your\s+)?(?:current\s+)?(?:credit|credits|quota)\b/i,
  /\b(?:out\s+of|no)\s+(?:available\s+)?(?:credit|credits|quota)\b/i,
];

function collectErrorText(value: unknown, seen = new Set<unknown>(), depth = 0): string[] {
  if (depth > 3 || value == null || seen.has(value)) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];

  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectErrorText(entry, seen, depth + 1));
  }

  const record = value as Record<string, unknown>;
  const text: string[] = [];
  for (const key of ['message', 'error', 'errors', 'error_description', 'detail', 'code', 'type']) {
    const field = record[key];
    if (typeof field === 'string') text.push(field);
    else if (key === 'error' || key === 'errors' || key === 'detail') {
      text.push(...collectErrorText(field, seen, depth + 1));
    }
  }
  return text;
}

/**
 * Classify a provider failure without returning or persisting provider text.
 * This intentionally recognizes only quota/credit exhaustion; missing
 * credentials and ordinary authentication errors remain separate states.
 */
export function classifyProviderError(value: unknown): ProviderErrorClassification | undefined {
  const matches = collectErrorText(value).some((text) =>
    CREDIT_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(text))
  );

  return matches
    ? {
        kind: PROVIDER_CREDIT_EXHAUSTED_ERROR_KIND,
        code: PROVIDER_CREDIT_EXHAUSTED_ERROR_CODE,
      }
    : undefined;
}
