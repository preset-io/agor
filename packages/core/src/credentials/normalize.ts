/**
 * Silent credential normalization (Layer 1).
 *
 * Repairs the artifacts of copying a token through a terminal or rich-text
 * editor: edge whitespace, zero-width characters, and smart/curly quotes are
 * always removed. For single-line tokens, internal whitespace/newlines are also
 * stripped — but that fix is flagged (`internalWhitespaceFixed`) so the UI can
 * warn, since it could otherwise mask a truncated paste. Multi-line values (PEM
 * private keys) get edge-trim only; their internal newlines are structural.
 */

import { resolveCredentialSpec } from './specs.js';

// Codepoints kept as \u escapes so the (invisible / look-alike) characters never
// appear as literals in source. Zero-width space, ZWNJ, ZWJ, word joiner, BOM \u2014
// written as an alternation (not a char class) since a ZWJ in a class trips
// biome's noMisleadingCharacterClass.
const ZERO_WIDTH = /\u200B|\u200C|\u200D|\u2060|\uFEFF/g;
// Curly/smart double quotes + prime → straight ASCII double quote.
const SMART_DOUBLE_QUOTE = /[\u201C\u201D\u201E\u201F\u2033]/g;
// Curly/smart single quotes + prime → straight ASCII single quote.
const SMART_SINGLE_QUOTE = /[\u2018\u2019\u201A\u201B\u2032]/g;
const INTERNAL_WHITESPACE = /\s+/g;

export interface CredentialNormalizationChanges {
  edgeTrimmed: boolean;
  strippedZeroWidth: boolean;
  fixedQuotes: boolean;
  /** Internal whitespace/newlines were removed (single-line tokens only). */
  collapsedInternal: boolean;
}

export interface NormalizeCredentialResult {
  value: string;
  original: string;
  changed: boolean;
  changes: CredentialNormalizationChanges;
  /**
   * True when an internal fix was applied. The UI must surface a dismissible
   * warning: the fix is usually correct, but could hide a truncated copy.
   */
  internalWhitespaceFixed: boolean;
}

/**
 * Normalize a credential value for a given field. Safe to call on every paste
 * and blur. Unknown fields get the conservative path (edge/zero-width/quotes,
 * never internal collapsing) since we can't assume they are single-line.
 */
export function normalizeCredential(field: string, value: string): NormalizeCredentialResult {
  const spec = resolveCredentialSpec(field);
  const singleLine = spec?.singleLine ?? false;

  const withoutZeroWidth = value.replace(ZERO_WIDTH, '');
  const withStraightQuotes = withoutZeroWidth
    .replace(SMART_DOUBLE_QUOTE, '"')
    .replace(SMART_SINGLE_QUOTE, "'");
  const edgeTrimmed = withStraightQuotes.trim();

  let normalized = edgeTrimmed;
  let collapsedInternal = false;
  if (singleLine) {
    const withoutInternal = edgeTrimmed.replace(INTERNAL_WHITESPACE, '');
    if (withoutInternal !== edgeTrimmed) {
      normalized = withoutInternal;
      collapsedInternal = true;
    }
  }

  const changes: CredentialNormalizationChanges = {
    edgeTrimmed: edgeTrimmed !== withStraightQuotes,
    strippedZeroWidth: withoutZeroWidth !== value,
    fixedQuotes: withStraightQuotes !== withoutZeroWidth,
    collapsedInternal,
  };

  return {
    value: normalized,
    original: value,
    changed: normalized !== value,
    changes,
    internalWhitespaceFixed: collapsedInternal,
  };
}
