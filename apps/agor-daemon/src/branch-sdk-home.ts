import path from 'node:path';

import { AGENTIC_TOOL_INTEGRATIONS, getAgenticToolIntegration } from '@agor/agentic-tools';
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

/**
 * Tools whose relocation is delivered through their own daemon `getExecutorLaunch`
 * hook rather than the generic env path. OpenCode derives its four XDG roots
 * from a single `dataHome` in its runtime (design §13.1 carry-forward #1) — the
 * flat "point every listed var at one path" reading is too coarse for it.
 */
const HOOK_MANAGED_TOOLS: ReadonlySet<AgenticToolName> = new Set<AgenticToolName>(['opencode']);

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
 * Returns `null` for hook-managed tools (opencode), whose values are derived by
 * their own launch hook. Throws for a tool with no relocation mechanism
 * (cursor) — callers MUST refuse such a session before reaching here
 * (design §11 step 5); this throw is a fail-closed backstop.
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
}): BranchSdkHomeLaunch | null {
  if (HOOK_MANAGED_TOOLS.has(input.tool)) return null;

  const override = getAgenticToolIntegration(input.tool).configHomeOverride;
  if (!override) {
    throw new Error(
      `Agentic tool "${input.tool}" does not support config-home relocation, so it cannot run ` +
        `on a branch with a per-branch SDK home. Refuse the prompt instead of reaching this path.`
    );
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

/**
 * Aggregate branch SDK home env for an interactive terminal (design §12 Q7 —
 * terminals get the branch home for consistency). A terminal is not scoped to
 * one tool, so it points EVERY generic-env-path tool's config-home var at the
 * branch home. OpenCode is deliberately excluded: its relocation is the four
 * `XDG_*` roots, which are too broad to force onto an arbitrary interactive
 * shell (they steer far more than OpenCode). OpenCode state in a raw terminal is
 * therefore not branch-relocated — a documented limitation.
 *
 * The per-caller credential env (API keys) is injected separately by
 * `createUserProcessEnvironment`, so the common terminal path authenticates
 * without any credential being written into the branch home.
 */
export function resolveBranchSdkHomeTerminalEnv(input: { branchId: string; tenantId?: string }): {
  branchHomeDir: string;
  envVars: Record<string, string>;
  ensureDirs: string[];
} {
  const branchHomeDir = getBranchHomePath(input.branchId, input.tenantId);
  const envVars: Record<string, string> = {};
  const dirs = new Set<string>([branchHomeDir]);
  for (const tool of Object.keys(AGENTIC_TOOL_INTEGRATIONS) as AgenticToolName[]) {
    if (HOOK_MANAGED_TOOLS.has(tool)) continue;
    if (!getAgenticToolIntegration(tool).configHomeOverride) continue;
    const launch = resolveBranchSdkHomeLaunch({
      tool,
      branchId: input.branchId,
      tenantId: input.tenantId,
    });
    if (!launch) continue;
    Object.assign(envVars, launch.envVars);
    for (const dir of launch.ensureDirs) dirs.add(dir);
  }
  return { branchHomeDir, envVars, ensureDirs: [...dirs] };
}
