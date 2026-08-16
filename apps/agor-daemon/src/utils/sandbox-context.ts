/**
 * Shared daemon-side helper for resolving the per-owner sandbox home store.
 *
 * Used by BOTH executor spawn sites (prompt tasks in register-services and web
 * terminals) so the store-path logic + `filesystem_home` validation live in one
 * place instead of drifting between call sites.
 *
 * See `context/explorations/executor-sandboxing.md`.
 */

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Resolve `$AGOR_DATA_HOME`, falling back to `~/.agor`. */
export function resolveDataHome(): string {
  return process.env.AGOR_DATA_HOME?.trim() || join(homedir(), '.agor');
}

/**
 * Validate an admin-supplied `users.filesystem_home` before it is used as a
 * writable bind source. It is a trust boundary: a bad value would expose or
 * mutate arbitrary host data from inside the sandbox. Rejects non-absolute
 * paths, `/`, and any path that overlaps the daemon data root (which would
 * re-expose `config.yaml`/`agor.db`/worktrees). Canonicalizes via `realpath`
 * when the dir already exists to blunt symlink swaps. Throws on violation.
 */
export function validateFilesystemHomeOverride(
  rawPath: string,
  dataHome = resolveDataHome()
): string {
  // Reject relative paths OUTRIGHT — do not silently `resolve()` them against
  // the daemon cwd (a value like `tmp/user` would otherwise be accepted).
  if (!isAbsolute(rawPath)) {
    throw new Error(`Invalid filesystem_home ${rawPath}: must be an absolute path`);
  }
  if (rawPath === '/') {
    throw new Error(`Invalid filesystem_home ${rawPath}: refusing to overlay the filesystem root`);
  }
  // Canonicalize BOTH sides (realpath when the dir exists) so a symlinked data
  // root or override can't sneak past the lexical prefix check below.
  const canonical = existsSync(rawPath) ? realpathSync(rawPath) : resolve(rawPath);
  const dhResolved = resolve(dataHome);
  const dh = existsSync(dhResolved) ? realpathSync(dhResolved) : dhResolved;
  // Reject the data root itself, an ancestor of it, or anything inside it — all
  // would let the overlay reach the daemon's trust root / worktrees / repos.
  if (canonical === dh || dh.startsWith(`${canonical}/`) || canonical.startsWith(`${dh}/`)) {
    throw new Error(
      `Invalid filesystem_home ${rawPath}: must not overlap the Agor data root (${dh})`
    );
  }
  return canonical;
}

/**
 * The per-owner home store overlaid at the passwd home under
 * `sandbox.home_mode: per_user`. The admin `filesystem_home` override wins (used
 * by the strict→sandbox migration to reuse an existing `/home/<user>` in
 * place); otherwise the canonical, tenant-scoped store — which is trusted by
 * construction and needs no validation.
 */
export function resolveOwnerHomeStore(params: {
  tenantId: string | undefined;
  ownerUserId: string;
  filesystemHome?: string | null;
  dataHome?: string;
}): string {
  const dataHome = params.dataHome ?? resolveDataHome();
  const override = params.filesystemHome?.trim();
  if (override) return validateFilesystemHomeOverride(override, dataHome);
  return join(dataHome, 'tenants', params.tenantId ?? 'default', 'homes', params.ownerUserId);
}
