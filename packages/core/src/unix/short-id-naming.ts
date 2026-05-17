/**
 * Carve-out: short-ID length used inside Unix group/user names.
 *
 * Everywhere else in the codebase, "short ID" means `SHORT_ID_LENGTH`
 * (24 chars) — the collision-safe display form for IDs users see.
 *
 * Unix names are different: they're persisted system-wide in `/etc/group`
 * and `/etc/passwd`, parsed by fixed-length regexes in this module, and
 * referenced by the `unix_group` / `unix_username` columns on every
 * worktree/repo/user row. Bumping this length would require migrating
 * every existing installation (old groups wouldn't match the new regex)
 * for no real win — Unix-name creation is rare and failure-loud
 * (`groupadd` errors if the name exists), so the collision risk that
 * motivates a longer display short-ID just doesn't apply.
 *
 * Lives next to `group-manager.ts` and `user-manager.ts` so the carve-out
 * is grep-able and self-documenting; deliberately NOT in `types/id.ts`
 * (the canonical short-ID home) to avoid suggesting it's a public
 * length people should reach for.
 */
export const UNIX_NAME_SHORT_ID_LENGTH = 8;
