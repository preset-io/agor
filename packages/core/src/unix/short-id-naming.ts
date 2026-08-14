/**
 * Carve-out: legacy short-ID length used in Unix user names and old Unix
 * group names.
 *
 * Everywhere else in the codebase, "short ID" means `SHORT_ID_LENGTH`
 * (24 chars) — the collision-safe display form for IDs users see.
 *
 * Unix usernames remain at eight characters for compatibility. Branch and
 * repo groups created before the collision-safe group-name change also used
 * this length; their persisted names remain valid and authoritative until an
 * administrator explicitly migrates them. New branch/repo groups use the
 * canonical 24-character `shortId()` instead.
 *
 * Lives next to `group-manager.ts` and `user-manager.ts` so the compatibility
 * carve-out is grep-able and self-documenting; deliberately NOT in
 * `types/id.ts` (the canonical short-ID home) to avoid suggesting it is a
 * public length people should reach for.
 */
export const UNIX_NAME_SHORT_ID_LENGTH = 8;
