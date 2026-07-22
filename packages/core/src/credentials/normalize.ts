/**
 * Silent credential normalization (Layer 1).
 *
 * Repairs the artifacts of copying a token through a terminal or rich-text
 * editor. Every value gets edge whitespace and zero-width characters removed.
 * For KNOWN credential fields we also strip a quote pair (smart/ASCII/backtick)
 * that wraps the entire value, and — for single-line tokens — collapse internal
 * whitespace/newlines. Both of those are flagged (`internalWhitespaceFixed`) so
 * the UI surfaces a dismissible notice, since either could mask a truncated
 * paste. Unknown fields (arbitrary env vars) get edge-trim + zero-width strip
 * ONLY — never quote or internal rewriting — so we don't silently mangle a value
 * we don't understand. Multi-line values (PEM keys) keep their internal newlines.
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

export interface CredentialNormalizationChanges {
  edgeTrimmed: boolean;
  strippedZeroWidth: boolean;
  /** A quote pair wrapping the entire value was removed (known fields only). */
  strippedWrappingQuotes: boolean;
  /** Internal whitespace/newlines were removed (single-line known fields only). */
  collapsedInternal: boolean;
}

export interface NormalizeCredentialResult {
  value: string;
  original: string;
  changed: boolean;
  changes: CredentialNormalizationChanges;
  /**
   * True when an internal fix was applied (internal-whitespace collapse or a
   * wrapping-quote strip). The UI must surface a dismissible warning: the fix is
   * usually correct, but could hide a truncated copy.
   */
  internalWhitespaceFixed: boolean;
}

const isQuote = (ch: string): boolean => QUOTE_CHAR.test(ch);

export function normalizeCredential(field: string, value: string): NormalizeCredentialResult {
  const spec = resolveCredentialSpec(field);
  const singleLine = spec?.singleLine ?? false;

  const withoutZeroWidth = value.replace(ZERO_WIDTH, '');
  const trimmed = withoutZeroWidth.trim();

  let working = trimmed;

  // Known credential fields only: strip a quote pair that wraps the whole value
  // (a paste artifact — a real token never starts and ends with a quote). Loop
  // to handle nested wrappers, re-trimming inside each layer. Any quote left in
  // the middle is intentionally NOT touched — the charset lint flags it instead.
  let strippedWrappingQuotes = false;
  if (spec) {
    while (working.length >= 2 && isQuote(working[0]) && isQuote(working[working.length - 1])) {
      working = working.slice(1, -1).trim();
      strippedWrappingQuotes = true;
    }
  }

  let collapsedInternal = false;
  if (singleLine) {
    const withoutInternal = working.replace(INTERNAL_WHITESPACE, '');
    if (withoutInternal !== working) {
      working = withoutInternal;
      collapsedInternal = true;
    }
  }

  const changes: CredentialNormalizationChanges = {
    edgeTrimmed: trimmed !== withoutZeroWidth,
    strippedZeroWidth: withoutZeroWidth !== value,
    strippedWrappingQuotes,
    collapsedInternal,
  };

  return {
    value: working,
    original: value,
    changed: working !== value,
    changes,
    internalWhitespaceFixed: collapsedInternal || strippedWrappingQuotes,
  };
}
