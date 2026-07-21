import { type CredentialLintResult, lintCredential, normalizeCredential } from '@agor-live/client';
import { useCallback, useState } from 'react';

export interface CredentialFieldState {
  /** Most recent lint finding (null when clean or not yet linted). */
  lint: CredentialLintResult | null;
  /** Whether the dismissible internal-whitespace notice should show. */
  showInternalFix: boolean;
}

const EMPTY: CredentialFieldState = { lint: null, showInternalFix: false };

/**
 * Per-field credential validation state. Timing follows the design contract:
 * `normalizeOnInput` fires on paste/blur (silent repair + internal-fix notice),
 * `lintOnBlur` fires on blur (format warnings). Never call these on keystroke.
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

  /** Normalize a raw value; surfaces the internal-fix notice when one was applied. */
  const normalizeOnInput = useCallback(
    (field: string, raw: string): string => {
      const result = normalizeCredential(field, raw);
      if (result.internalWhitespaceFixed) patch(field, { showInternalFix: true });
      return result.value;
    },
    [patch]
  );

  /** Run format lint for a field (call on blur). */
  const lintOnBlur = useCallback(
    (field: string, value: string) => {
      patch(field, { lint: lintCredential(field, value) });
    },
    [patch]
  );

  const dismissInternalFix = useCallback(
    (field: string) => patch(field, { showInternalFix: false }),
    [patch]
  );

  /** Clear all transient state for a field (e.g. after save/clear). */
  const reset = useCallback((field: string) => patch(field, { ...EMPTY }), [patch]);

  return { get, normalizeOnInput, lintOnBlur, dismissInternalFix, reset };
}
