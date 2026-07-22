/**
 * Credential cleanup (Layer 1), split by how much consent it needs.
 *
 * `sanitizeCredential` is the ALWAYS-automatic part: it strips edge whitespace
 * and invisible/zero-width characters. These are never visible and never
 * intentional, so there is nothing for a user to notice — safe to apply on
 * paste/blur/save and as a daemon backstop.
 *
 * `detectCredentialFix` / `applyCredentialFix` are the OPT-IN part: internal
 * whitespace (the mid-token space/newline) and a quote pair wrapping the whole
 * value. We NEVER rewrite these behind the user's back — a token is content they
 * chose. Instead the UI detects them and offers a one-click "Clean it up" action
 * that calls `applyCredentialFix`. Multi-line values (PEM keys) are exempt.
 */

import { resolveCredentialSpec } from './specs.js';

// Codepoints kept as \u escapes so the (invisible / look-alike) characters never
// appear as literals in source. Zero-width space, ZWNJ, ZWJ, word joiner, BOM —
// written as an alternation (not a char class) since a ZWJ in a class trips
// biome's noMisleadingCharacterClass.
const ZERO_WIDTH = /​|‌|‍|⁠|﻿/g;
// A single quote character: ASCII double/single/backtick + smart/curly variants
// and primes. Used to detect a quote pair wrapping the whole value.
const QUOTE_CHAR = /["'`‘’‚‛′“”„‟″]/;
const INTERNAL_WHITESPACE = /\s+/g;
const HAS_WHITESPACE = /\s/;

const isQuote = (ch: string): boolean => QUOTE_CHAR.test(ch);

/**
 * Always-safe automatic cleanup: strip zero-width/invisible characters and edge
 * whitespace. Field-independent (safe for single-line tokens and multi-line PEM
 * alike — internal content is never touched).
 */
export function sanitizeCredential(value: string): string {
  return value.replace(ZERO_WIDTH, '').trim();
}

export type CredentialFixKind = 'internal-whitespace' | 'wrapping-quotes';

export interface CredentialFixSuggestion {
  /** Warning text describing the issue (the action label lives in the UI). */
  message: string;
  /** The value with the opt-in fix applied — what the one-click action sets. */
  fixedValue: string;
  /** Which issues were detected. */
  kinds: CredentialFixKind[];
}

/** Strip quote pairs wrapping the whole value (loops for nested wrappers). */
function unwrapQuotes(value: string): string {
  let working = value;
  while (working.length >= 2 && isQuote(working[0]) && isQuote(working[working.length - 1])) {
    working = working.slice(1, -1).trim();
  }
  return working;
}

/**
 * Apply the OPT-IN fixes (quote-unwrap + internal-whitespace collapse) on top of
 * sanitization. Only eligible for known single-line credential fields; returns
 * the value unchanged for unknown or multi-line fields. Called only when the
 * user explicitly asks to clean the value up.
 */
export function applyCredentialFix(field: string, value: string): string {
  const spec = resolveCredentialSpec(field);
  if (!spec?.singleLine) return sanitizeCredential(value);
  return unwrapQuotes(sanitizeCredential(value)).replace(INTERNAL_WHITESPACE, '');
}

function messageForKinds(kinds: CredentialFixKind[]): string {
  const hasInternal = kinds.includes('internal-whitespace');
  const hasQuotes = kinds.includes('wrapping-quotes');
  if (hasInternal && hasQuotes) {
    return 'This key has extra spaces, line breaks, or wrapping quotes in it — a common side effect of copying from a terminal.';
  }
  if (hasQuotes) {
    return "This key is wrapped in quotation marks — that's usually an accidental copy artifact.";
  }
  return 'This key has extra spaces or line breaks in it — a common side effect of copying from a terminal.';
}

/**
 * Detect an opt-in-fixable issue on a value. Returns null when clean, or when the
 * field isn't an eligible single-line credential. Operates on the sanitized value
 * so invisible/edge noise never triggers it — only genuine internal whitespace or
 * wrapping quotes do. Does NOT mutate; the caller decides whether to apply the fix.
 */
export function detectCredentialFix(field: string, value: string): CredentialFixSuggestion | null {
  const spec = resolveCredentialSpec(field);
  if (!spec?.singleLine) return null;

  const sanitized = sanitizeCredential(value);
  if (!sanitized) return null;

  const kinds: CredentialFixKind[] = [];
  let body = sanitized;
  if (body.length >= 2 && isQuote(body[0]) && isQuote(body[body.length - 1])) {
    kinds.push('wrapping-quotes');
    body = unwrapQuotes(body);
  }
  if (HAS_WHITESPACE.test(body)) {
    kinds.push('internal-whitespace');
  }
  if (kinds.length === 0) return null;

  return {
    message: messageForKinds(kinds),
    fixedValue: applyCredentialFix(field, sanitized),
    kinds,
  };
}
