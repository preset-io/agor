/** Shared layout/timing values for the Marketplace's coordinated drawers. */
export const MARKETPLACE_CATALOG_DRAWER_WIDTH = 520;
export const MARKETPLACE_SERVER_DRAWER_WIDTH = 560;
export const MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS = 350;

/** Bounded durable checks used only while a newly-created OAuth session is pending. */
export const MARKETPLACE_OAUTH_POLL_DELAYS_MS = [750, 1_500, 3_000, 6_000] as const;
