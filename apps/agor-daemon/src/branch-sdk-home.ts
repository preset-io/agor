import path from 'node:path';

import { getAgenticToolIntegration } from '@agor/agentic-tools';
import type { AgorConfig } from '@agor/core/config';
import { getBranchHomePath } from '@agor/core/config';
import type { AgenticToolName } from '@agor/core/types';

/**
 * Per-branch SDK home resolution (design §6/§7/§8/§9).
 *
 * The deployment flag `execution.sandbox.sdk_home_mode` decides whether NEW
 * branches adopt an SDK home; once a branch has one it is sticky (recorded on
 * the branch record — see design §8B.3), so the *live* value of this flag never
 * strands an existing branch's accumulated state. This module owns:
 *   1. the deployment-level policy read (`resolveSdkHomeConfig`);
 *   2. the per-tool env-var wiring that points a tool at the branch home.
 *
 * The env var NAMES come from the Phase 2 `configHomeOverride` mapping (single
 * source of truth in `@agor/agentic-tools`); only the on-disk sub-path layout
 * is a daemon-side policy here.
 */

export type SdkHomeMode = 'inherit' | 'per_branch';

/**
 * Deployment-level SDK-home policy. Precedent: `resolveWebTerminalCapability`
 * (`terminal-capability.ts`) — a single helper instead of reading the raw
 * config key at N call sites (design §9.1).
 */
export function resolveSdkHomeConfig(config: Pick<AgorConfig, 'execution'>): {
  mode: SdkHomeMode;
  /** Whether a branch prompted for the first time should adopt an SDK home. */
  enabledForNewBranches: boolean;
} {
  const mode: SdkHomeMode = config.execution?.sandbox?.sdk_home_mode ?? 'inherit';
  return { mode, enabledForNewBranches: mode === 'per_branch' };
}

/**
 * Per-env-var sub-directory under the branch SDK home. Keyed by the env var
 * name recorded in the tool's `configHomeOverride`. Codex's two vars co-locate
 * (its sqlite state lives inside the codex home); Copilot's cache is a distinct
 * dir because `COPILOT_CACHE_HOME` does not follow `COPILOT_HOME` (design
 * §8A.6 item 5). Fail closed on an unmapped name so a newly added tool cannot
 * be silently mis-wired.
 */
const ENV_VAR_SUBDIR: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CONFIG_DIR: 'claude',
  CODEX_HOME: 'codex',
  CODEX_SQLITE_HOME: 'codex',
  GEMINI_CLI_HOME: 'gemini',
  COPILOT_HOME: 'copilot',
  COPILOT_CACHE_HOME: 'copilot-cache',
});

/** Why a tool must be refused before a branch adopts shared SDK state. */
export function branchSdkHomeUnsupportedReason(tool: AgenticToolName): string | undefined {
  const integration = getAgenticToolIntegration(tool);
  if (!integration.capabilities.supportsConfigHomeOverride) {
    return 'its SDK cannot relocate its config/state directory';
  }
  if (tool === 'opencode') {
    return 'its current XDG data home combines native credentials with relocatable state';
  }
  return undefined;
}

/** Local native-auth modes that cannot keep credentials out of branch state. */
export function branchSdkHomeAuthUnsupportedReason(input: {
  tool: AgenticToolName;
  delegated: boolean;
  auth?: { useNativeAuth: boolean; apiKey?: string };
}): string | undefined {
  if (
    input.tool === 'codex' &&
    !input.delegated &&
    input.auth?.useNativeAuth === true &&
    !input.auth.apiKey
  ) {
    return (
      'local Codex subscription auth cannot separate auth.json from its writable config home ' +
      'safely; switch Codex to an API key, use a reviewed delegated launcher, or use a branch ' +
      'without a per-branch SDK home'
    );
  }
  return undefined;
}

export type BranchSdkHomeLaunch = {
  /** Host path of the branch SDK home (bind-mount source + real state root). */
  branchHomeDir: string;
  /** Env vars to inject so the tool writes into the branch home. */
  envVars: Record<string, string>;
  /** Directories to create before spawn — the bind source must exist (design §7.2). */
  ensureDirs: string[];
};

/**
 * Resolve the branch SDK home launch (env vars + dirs) for a tool that
 * relocates through the generic env path.
 *
 * Throws for tools that cannot preserve the branch-state/caller-credential
 * boundary. Callers MUST refuse such a session before reaching here; this throw
 * is a fail-closed backstop.
 *
 * The returned env values are REAL absolute host paths (sub-dirs of the branch
 * home). The sandbox binds the branch home at its own real path, so the same
 * value is valid inside and outside the sandbox — and in non-sandboxed modes
 * the daemon-account process reaches it directly. This uniformity is why the
 * env values do not depend on the in-sandbox `$HOME`.
 */
export function resolveBranchSdkHomeLaunch(input: {
  tool: AgenticToolName;
  branchId: string;
  tenantId?: string;
}): BranchSdkHomeLaunch {
  const unsupportedReason = branchSdkHomeUnsupportedReason(input.tool);
  if (unsupportedReason) {
    throw new Error(
      `Agentic tool "${input.tool}" cannot use a per-branch SDK home because ${unsupportedReason}.`
    );
  }

  const override = getAgenticToolIntegration(input.tool).configHomeOverride;
  if (!override) {
    throw new Error(`Missing config-home relocation metadata for supported tool ${input.tool}.`);
  }

  const branchHomeDir = getBranchHomePath(input.branchId, input.tenantId);
  const envVars: Record<string, string> = {};
  const dirs = new Set<string>([branchHomeDir]);
  for (const name of override.envVars) {
    const subdir = ENV_VAR_SUBDIR[name];
    if (!subdir) {
      throw new Error(
        `No branch-SDK-home sub-dir mapping for env var "${name}" (tool ${input.tool}). ` +
          `Add it to ENV_VAR_SUBDIR in branch-sdk-home.ts.`
      );
    }
    const dir = path.join(branchHomeDir, subdir);
    envVars[name] = dir;
    dirs.add(dir);
  }
  return { branchHomeDir, envVars, ensureDirs: [...dirs] };
}
