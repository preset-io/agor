/**
 * Model metadata for the Oh My Pi runtime.
 *
 * OMP is provider-agnostic and resolves models from its own configuration, so
 * Agor deliberately does NOT hardcode a catalogue here. OMP reports the real
 * context window per turn via `get_state`; this fallback only covers the case
 * where that reading is unavailable.
 */

/**
 * Conservative fallback context window, used only when OMP did not report one.
 * Chosen to match the smallest window in common use so Agor under-promises
 * rather than showing a falsely low occupancy percentage.
 */
export const DEFAULT_OMP_CONTEXT_WINDOW = 200_000;

/**
 * Resolve the context-window limit for an OMP turn.
 *
 * @param reportedWindow - Window OMP reported for the active model, if any.
 */
export function getOmpContextWindowLimit(reportedWindow?: number): number {
  return reportedWindow && reportedWindow > 0 ? reportedWindow : DEFAULT_OMP_CONTEXT_WINDOW;
}
