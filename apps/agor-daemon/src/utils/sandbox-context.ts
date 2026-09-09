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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type AgorConfig,
  getAgorHome,
  resolveDataHomeFromConfig,
  resolveTenantDataRootFromConfig,
  resolveTenantsBaseFolderFromConfig,
} from '@agor/core/config';
import type { DeepReadonly } from '@agor/core/types';

export interface SandboxStoragePaths {
  dataHome: string;
  protectedDataRoots: string[];
  worktreesRoot: string;
  ownerHomesRoot: string;
}

/** Canonicalize the deepest existing ancestor while retaining an uncreated suffix. */
function canonicalizeProspectivePath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolve(path);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...suffix);
}

/** Resolve tenant-aware sandbox storage paths from the immutable config snapshot. */
export function resolveSandboxStoragePaths(
  config: DeepReadonly<AgorConfig>,
  tenantId: string | undefined
): SandboxStoragePaths {
  const agorHome = getAgorHome();
  const dataHome = resolveDataHomeFromConfig(config, agorHome);
  const filesystemIsolation = config.multi_tenancy?.filesystem_isolation_enabled === true;
  const tenantDataRoot = filesystemIsolation
    ? resolveTenantDataRootFromConfig(config, dataHome, agorHome, tenantId)
    : dataHome;
  const protectedDataRoots = [dataHome];
  if (filesystemIsolation) {
    protectedDataRoots.push(resolveTenantsBaseFolderFromConfig(config, agorHome));
  }
  return {
    dataHome,
    protectedDataRoots: [...new Set(protectedDataRoots)],
    worktreesRoot: join(tenantDataRoot, 'worktrees'),
    ownerHomesRoot: filesystemIsolation
      ? join(tenantDataRoot, 'homes')
      : join(
          dataHome,
          'tenants',
          tenantId ?? config.multi_tenancy?.static_tenant_id ?? 'default',
          'homes'
        ),
  };
}

/** Resolve deployment-global roots that a per-user sandbox must hide. */
export function resolveSandboxProtectedDataRoots(config: DeepReadonly<AgorConfig>): string[] {
  const agorHome = getAgorHome();
  const roots = [resolveDataHomeFromConfig(config, agorHome)];
  if (config.multi_tenancy?.filesystem_isolation_enabled === true) {
    roots.push(resolveTenantsBaseFolderFromConfig(config, agorHome));
  }
  return [...new Set(roots)];
}

/**
 * Validate an admin-supplied `users.filesystem_home` before it is used as a
 * writable bind source. It is a trust boundary: a bad value would expose or
 * mutate arbitrary host data from inside the sandbox. Rejects non-absolute
 * paths, `/`, and any path that overlaps the daemon data root (which would
 * re-expose `config.yaml`/`agor.db`/worktrees). Canonicalizes via `realpath`
 * when the dir already exists to blunt symlink swaps. Throws on violation.
 */
export function validateFilesystemHomeOverride(rawPath: string, dataHome: string): string {
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
  config: DeepReadonly<AgorConfig>;
  tenantId: string | undefined;
  ownerUserId: string;
  filesystemHome?: string | null;
}): string {
  const storage = resolveSandboxStoragePaths(params.config, params.tenantId);
  const override = params.filesystemHome?.trim();
  if (override) {
    let validated = override;
    for (const root of storage.protectedDataRoots) {
      validated = validateFilesystemHomeOverride(validated, root);
    }
    return validated;
  }
  // Credential authority opens every component without following symlinks.
  // Resolve a trusted deployment-root symlink before appending any uncreated
  // tenant/home suffix so supported symlinked data roots retain one stable
  // physical authority rather than failing every task or exposing an alias.
  return join(canonicalizeProspectivePath(storage.ownerHomesRoot), params.ownerUserId);
}
