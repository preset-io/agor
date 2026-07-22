import {
  applyCredentialFix,
  type CredentialFixSuggestion,
  type CredentialLintResult,
  detectCredentialFix,
  lintCredential,
  sanitizeCredential,
} from '@agor-live/client';
import { useCallback, useState } from 'react';

export interface CredentialFieldState {
  /** Most recent lint finding (null when clean or not yet linted). */
  lint: CredentialLintResult | null;
  /** Opt-in fix suggestion (null when clean). Never applied automatically. */
  fix: CredentialFixSuggestion | null;
}

const EMPTY: CredentialFieldState = { lint: null, fix: null };

/**
 * Per-field credential validation state. Timing follows the design contract:
 * `inspect` fires on paste/blur — it applies the always-safe sanitize (edge +
 * invisible chars) and returns that value for the caller to display, while
 * detecting (but NOT applying) the opt-in fixes and running the format lint.
 * `applyFix` runs only when the user clicks "Clean it up". Never call these on
 * keystroke.
 *
 * Keyed by field id so one hook serves a whole surface (e.g. all agent-tool
 * inputs) without breaking the rules of hooks.
 */
export function useCredentialFields() {
  const [states, setStates] = useState<Record<string, CredentialFieldState>>({});

  const get = useCallback(
    (field: string): CredentialFieldState => states[field] ?? EMPTY,
    [states]
  );

  const patch = useCallback((field: string, next: Partial<CredentialFieldState>) => {
    setStates((prev) => ({ ...prev, [field]: { ...(prev[field] ?? EMPTY), ...next } }));
  }, []);

  /**
   * Sanitize a raw value (always-safe edge + invisible-char cleanup), then detect
   * the opt-in fix + lint on the sanitized value. Returns the sanitized value for
   * the caller to write back to the field. Does NOT collapse internal whitespace
   * or unwrap quotes — those are surfaced as an opt-in suggestion only.
   */
  const inspect = useCallback(
    (field: string, raw: string): string => {
      const sanitized = sanitizeCredential(raw);
      patch(field, {
        fix: detectCredentialFix(field, sanitized),
        lint: lintCredential(field, sanitized),
      });
      return sanitized;
    },
    [patch]
  );

  /**
   * Apply the opt-in fix to the current value (user clicked "Clean it up").
   * Returns the cleaned value and clears the suggestion (re-linting the result).
   */
  const applyFix = useCallback(
    (field: string, currentValue: string): string => {
      const fixed = applyCredentialFix(field, currentValue);
      patch(field, { fix: null, lint: lintCredential(field, fixed) });
      return fixed;
    },
    [patch]
  );

  /** Clear all transient state for a field (e.g. on manual edit or after save). */
  const reset = useCallback((field: string) => patch(field, { ...EMPTY }), [patch]);

  return { get, inspect, applyFix, reset };
}
