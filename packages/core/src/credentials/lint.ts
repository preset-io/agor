/**
 * Credential format lint (Layer 2).
 *
 * Warnings, never blockers — providers change formats, and a stale hard block is
 * worse than no check. Returns at most one finding (the most actionable) so a
 * surface can render a single inline message. `error` severity is reserved for an
 * impossible charset; everything else is a `warning`.
 *
 * Cross-paste detection is special-cased for the two Anthropic fields, which are
 * easy to swap and where the fix ("paste it in the other field") is unambiguous.
 */

import { CREDENTIAL_SPECS, type CredentialSpec, resolveCredentialSpec } from './specs.js';

export type CredentialLintSeverity = 'warning' | 'error';

export interface CredentialLintResult {
  severity: CredentialLintSeverity;
  code: 'cross-paste' | 'charset' | 'prefix' | 'length';
  message: string;
  /** Field the value likely belongs in (cross-paste only). */
  suggestField?: string;
}

const startsWithAny = (value: string, prefixes: string[]): boolean =>
  prefixes.some((prefix) => value.startsWith(prefix));

/** Anthropic API-key ↔ subscription-token swap detection. Returns null if not applicable. */
function detectCrossPaste(spec: CredentialSpec, value: string): CredentialLintResult | null {
  if (
    spec.key === 'anthropic-api-key' &&
    startsWithAny(value, CREDENTIAL_SPECS['anthropic-oauth-token'].prefixes)
  ) {
    return {
      severity: 'warning',
      code: 'cross-paste',
      message:
        'This looks like a Claude Pro/Max token (sk-ant-oat…). Paste it in the Claude subscription field instead.',
      suggestField: 'CLAUDE_CODE_OAUTH_TOKEN',
    };
  }
  if (
    spec.key === 'anthropic-oauth-token' &&
    startsWithAny(value, CREDENTIAL_SPECS['anthropic-api-key'].prefixes)
  ) {
    return {
      severity: 'warning',
      code: 'cross-paste',
      message:
        'This looks like an Anthropic API key (sk-ant-api…). Paste it in the Anthropic API Key field instead.',
      suggestField: 'ANTHROPIC_API_KEY',
    };
  }
  return null;
}

/**
 * Lint a (preferably normalized) credential value for format smells. Returns null
 * when the value is empty or looks fine. Never throws and never blocks save.
 */
export function lintCredential(field: string, value: string): CredentialLintResult | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const spec = resolveCredentialSpec(field);
  if (!spec) return null;

  const crossPaste = detectCrossPaste(spec, trimmed);
  if (crossPaste) return crossPaste;

  if (spec.charset && spec.singleLine && !spec.charset.test(trimmed)) {
    return {
      severity: 'error',
      code: 'charset',
      message: `This ${spec.provider} key contains characters that aren't valid for a token — check for a stray space or a copy/paste error.`,
    };
  }

  if (spec.prefixes.length > 0 && !startsWithAny(trimmed, spec.prefixes)) {
    return {
      severity: 'warning',
      code: 'prefix',
      message: `${spec.provider} keys usually start with ${spec.prefixHint}. Double-check you copied the right key.`,
    };
  }

  if (spec.minLength && trimmed.length < spec.minLength) {
    return {
      severity: 'warning',
      code: 'length',
      message: `This ${spec.provider} key looks incomplete — it may have been truncated when copied.`,
    };
  }

  return null;
}
