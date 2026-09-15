/**
 * Visual spacing is board-space geometry, not drag-grid geometry. Keep every
 * default and numeric rule here so board layout, selection layout, Auto Zone,
 * the daemon, and MCP cannot quietly acquire different density contracts.
 */
export const LAYOUT_SPACING_DEFAULTS = Object.freeze({
  boardColumnGap: 64,
  boardRowGap: 48,
  boardOuterMargin: 96,
  zoneColumnGap: 40,
  zoneRowGap: 32,
  zonePadding: 32,
  zoneHeaderReserve: 64,
});

/**
 * Pre-axis zone policies omitted padding and used one 24px gap. Reading those
 * sparse persisted overrides with their historical implied geometry avoids a
 * one-time background Auto Zone move on upgrade. Any newly normalized policy
 * is written with the canonical axis/inset fields instead.
 */
export const LEGACY_ZONE_LAYOUT_SPACING = Object.freeze({
  columnGap: 24,
  rowGap: 24,
  padding: 20,
});

export const MAX_LAYOUT_SPACING = 320;

/** Preserve an exact finite value while bounding pathological canvas input. */
export function normalizeLayoutSpacing(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_LAYOUT_SPACING, Math.max(0, value))
    : fallback;
}

/** New axis values win; the scalar is a read-only compatibility alias. */
export function normalizeAxisSpacing(
  columnGap: unknown,
  rowGap: unknown,
  legacyGap: unknown,
  defaults: { columnGap: number; rowGap: number }
): { columnGap: number; rowGap: number } {
  const legacy =
    typeof legacyGap === 'number' && Number.isFinite(legacyGap) ? legacyGap : undefined;
  const normalizedLegacy = legacy === undefined ? undefined : normalizeLayoutSpacing(legacy, 0);
  return {
    columnGap: normalizeLayoutSpacing(columnGap, normalizedLegacy ?? defaults.columnGap),
    rowGap: normalizeLayoutSpacing(rowGap, normalizedLegacy ?? defaults.rowGap),
  };
}
