/**
 * Diagnostics for the OS-level executor sandbox (SRT: bubblewrap / Seatbelt).
 * Reports whether the policy is enabled and whether the host has the runtime
 * dependencies the sandbox needs on this platform. Pure except for a PATH scan.
 *
 * See `context/explorations/executor-sandboxing.md`.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import type { AgorConfig } from '@agor/core/config';

export interface SandboxDepStatus {
  name: string;
  present: boolean;
  /** True when this dep is required on the current platform. */
  required: boolean;
  note?: string;
}

export interface SandboxDiagnosis {
  enabled: boolean;
  platform: NodeJS.Platform;
  supported: boolean;
  deps: SandboxDepStatus[];
  /** enabled + supported + all required deps present. */
  ok: boolean;
}

/**
 * Functionally probe that bwrap can actually create an unprivileged user +
 * mount namespace on THIS host — the thing that silently fails on hardened
 * kernels (Ubuntu 24.04 AppArmor `apparmor_restrict_unprivileged_userns`,
 * `kernel.unprivileged_userns_clone=0`, some container runtimes). A PATH check
 * is not enough: bwrap can be installed yet unable to run. Returns false on any
 * nonzero exit / spawn error.
 */
export function probeBwrapUserns(): boolean {
  try {
    const r = spawnSync(
      'bwrap',
      ['--unshare-user', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', 'true'],
      { stdio: 'ignore', timeout: 10_000 }
    );
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Is an executable of this name resolvable on PATH? (no subprocess) */
export function hasBinaryOnPath(name: string, pathEnv = process.env.PATH ?? ''): boolean {
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // not here / not executable — keep scanning
    }
  }
  return false;
}

export function diagnoseSandbox(
  config: Pick<AgorConfig, 'execution'>,
  platform: NodeJS.Platform = process.platform,
  // Injectable for tests. Only invoked when bwrap is present on Linux.
  probeUserns: () => boolean = probeBwrapUserns
): SandboxDiagnosis {
  const enabled = config.execution?.sandbox?.enabled === true;

  let deps: SandboxDepStatus[];
  let supported = true;

  if (platform === 'linux') {
    // Filesystem-only sandbox uses raw bubblewrap. Presence on PATH is
    // necessary but NOT sufficient — also prove userns actually works.
    const bwrapPresent = hasBinaryOnPath('bwrap');
    deps = [{ name: 'bwrap', required: true, present: bwrapPresent, note: 'bubblewrap' }];
    if (bwrapPresent) {
      deps.push({
        name: 'unprivileged userns',
        required: true,
        present: probeUserns(),
        note: 'bwrap --unshare-user smoke test (fails on hardened kernels)',
      });
    }
  } else {
    // macOS/Windows: the bubblewrap-based sandbox is Linux-only for now.
    supported = false;
    deps = [];
  }

  const requiredPresent = deps.filter((d) => d.required).every((d) => d.present);
  return { enabled, platform, supported, deps, ok: enabled && supported && requiredPresent };
}

/** One-line install hint for missing Linux deps. */
export function sandboxInstallHint(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'linux') {
    return (
      'Debian/Ubuntu: sudo apt-get install -y bubblewrap' +
      '  (Ubuntu 24.04+: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0)'
    );
  }
  return null;
}
