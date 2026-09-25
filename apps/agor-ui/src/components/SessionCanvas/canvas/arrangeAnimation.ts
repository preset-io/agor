/**
 * Timing for the deal animation an arrange plays as items fly to their slots.
 *
 * The feel being copied is a card game dealing a row: items do not all move at
 * once, they leave in reading order a beat apart, and each one eases into place
 * rather than stopping dead. That reads as "the board is arranging itself"
 * instead of "the board teleported".
 *
 * The stagger is a *budget*, not a per-item constant. A fixed delay per item
 * looks right for six cards and takes four seconds for sixty, so the step
 * shrinks as the count grows and the whole deal still finishes in about the
 * same time. The floor keeps a large board from collapsing back into a single
 * indistinguishable jump.
 */

export interface DealTimingOptions {
  /** Number of items being dealt. */
  count: number;
  /** Longest the deal may take to *start* its final item. */
  staggerBudgetMs?: number;
  /** Never step faster than this, or the stagger stops reading as one. */
  minStepMs?: number;
  /** Never step slower than this, however few items there are. */
  maxStepMs?: number;
  /** How long a single item takes to travel. */
  durationMs?: number;
  /**
   * Honour the viewer's reduced-motion preference by dealing instantly.
   * Vestibular triggers are not a style choice, so this collapses the whole
   * animation rather than merely shortening it.
   */
  reducedMotion?: boolean;
}

export interface DealTiming {
  stepMs: number;
  durationMs: number;
  /** When the last item finishes, i.e. how long to keep the animation class. */
  totalMs: number;
}

const DEFAULTS = {
  staggerBudgetMs: 420,
  minStepMs: 8,
  maxStepMs: 45,
  durationMs: 380,
};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const positiveOr = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback;

export function dealTiming(options: DealTimingOptions): DealTiming {
  const count = Math.max(0, Math.floor(options.count));
  const durationMs = positiveOr(options.durationMs, DEFAULTS.durationMs);

  if (options.reducedMotion || count === 0) {
    return { stepMs: 0, durationMs: 0, totalMs: 0 };
  }

  const budget = positiveOr(options.staggerBudgetMs, DEFAULTS.staggerBudgetMs);
  const minStep = positiveOr(options.minStepMs, DEFAULTS.minStepMs);
  const maxStep = positiveOr(options.maxStepMs, DEFAULTS.maxStepMs);
  // One item has nothing to stagger against.
  const gaps = Math.max(1, count - 1);
  const stepMs = count <= 1 ? 0 : clamp(budget / gaps, Math.min(minStep, maxStep), maxStep);

  return {
    stepMs,
    durationMs,
    totalMs: Math.round(stepMs * gaps + durationMs),
  };
}

/** Delay for the item at `index` in deal order. */
export function dealDelayMs(index: number, timing: DealTiming): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.round(Math.floor(index) * timing.stepMs);
}

/**
 * Deal order for a grid placement: reading order, rows before columns.
 *
 * Dealing by row is what makes the animation legible — the eye follows one
 * line at a time. Ordering by raw array index instead would deal in whatever
 * order the solver happened to emit, which looks like scatter.
 */
export function dealOrderIndex(
  placement: { row: number; column: number },
  columns: number
): number {
  const safeColumns = Math.max(1, Math.floor(columns));
  return (
    Math.max(0, Math.floor(placement.row)) * safeColumns + Math.max(0, Math.floor(placement.column))
  );
}

/** CSS custom properties a dealt node carries. Kept here so the names live beside the timing. */
export function dealStyle(delayMs: number, timing: DealTiming): Record<string, string> {
  return {
    '--agor-deal-delay': `${delayMs}ms`,
    '--agor-deal-duration': `${timing.durationMs}ms`,
  };
}

/**
 * Class held for the duration of one arrange.
 *
 * Belongs on the element that already carries `.react-flow`: the stylesheet
 * qualifies the rules with it so their specificity matches the tool-mode rules
 * they sit beside. On any other element the selectors simply never match.
 */
export const ARRANGE_DEAL_CLASS = 'agor-dealing';
