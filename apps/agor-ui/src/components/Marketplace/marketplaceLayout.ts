/** Shared layout/timing values for the Marketplace's coordinated drawers. */
export const MARKETPLACE_CATALOG_DRAWER_WIDTH = 520;
export const MARKETPLACE_SERVER_DRAWER_WIDTH = 560;
export const MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS = 350;
export const MARKETPLACE_ACTION_COLUMN_WIDTH = 128;

/** Bounded durable checks used only while a newly-created OAuth session is pending. */
export const MARKETPLACE_OAUTH_POLL_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
] as const;

/** Recheck remote capabilities only after a bounded freshness window. */
export const MARKETPLACE_TOOL_DISCOVERY_STALE_MS = 15 * 60 * 1000;
