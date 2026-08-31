/**
 * Diagnostics for the OS-level executor sandbox (SRT: bubblewrap / Seatbelt).
 * Reports whether the policy is enabled and whether the host has the runtime
 * dependencies the sandbox needs on this platform. Pure except for a PATH scan.
 *
 * See `context/explorations/executor-sandboxing.md`.
 */

import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import type { AgorConfig } from '@agor/core/config';
// Shared with the daemon so CLI + daemon never drift on what "sandbox
// available" means (functional userns probe, not just PATH presence).
import {
  probeBwrapBindFd,
  probeBwrapPidNamespace,
  probeBwrapSafeSetupPathResolution,
  probeBwrapUserns,
} from '@agor/core/unix';

export {
  probeBwrapBindFd,
  probeBwrapPidNamespace,
  probeBwrapSafeSetupPathResolution,
  probeBwrapUserns,
};

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
  probeUserns: () => boolean = probeBwrapUserns,
  probePidNs: () => boolean = probeBwrapPidNamespace,
  probeSafeSetup: () => boolean = probeBwrapSafeSetupPathResolution,
  probeBindFd: () => boolean = probeBwrapBindFd
): SandboxDiagnosis {
  const enabled = config.execution?.sandbox?.enabled === true;

  let deps: SandboxDepStatus[];
  let supported = true;

  if (platform === 'linux') {
    // The sandbox uses raw bubblewrap. Presence on PATH is necessary but NOT
    // sufficient — also prove the user namespace actually works.
    const bwrapPresent = hasBinaryOnPath('bwrap');
    deps = [{ name: 'bwrap', required: true, present: bwrapPresent, note: 'bubblewrap' }];
    if (bwrapPresent) {
      deps.push({
        name: 'safe setup paths',
        required: true,
        present: probeSafeSetup(),
        note: 'bubblewrap 0.12.0+ (GHSA-pxhw-h44j-8pfx fix)',
      });
      deps.push({
        name: 'unprivileged userns',
        required: true,
        present: probeUserns(),
        note: 'bwrap --unshare-user smoke test (fails on hardened kernels)',
      });
      deps.push({
        name: 'descriptor binds',
        required: true,
        present: probeBindFd(),
        note: 'functional bwrap --bind-fd smoke test',
      });
      // PID namespace is a best-effort hardening, NOT required: it closes the
      // /proc process-side vector but is commonly blocked in containers.
      deps.push({
        name: 'PID namespace',
        required: false,
        present: probePidNs(),
        note: 'bwrap --unshare-pid; hardening — often unavailable in containers',
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
      'Install bubblewrap 0.12.0 or newer' +
      '  (Ubuntu 24.04+: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0)'
    );
  }
  return null;
}
