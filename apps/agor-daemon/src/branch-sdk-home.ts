import path from 'node:path';

import { getAgenticToolIntegration } from '@agor/agentic-tools';
import type { AgorConfig, KeyResolutionContext } from '@agor/core/config';
import { getBranchHomePath, resolveApiKey } from '@agor/core/config';
import type { AgenticToolName, SessionSdkHomeScope, UserID } from '@agor/core/types';

/**
 * Per-branch SDK home resolution (design §6/§7/§8/§9).
 *
 * The deployment flag `execution.sandbox.sdk_home_mode` decides whether NEW
 * sessions on an unadopted branch use a branch SDK home. Branch intent and the
 * session's immutable scope are both sticky, so the *live* value of this flag
 * never moves an existing SDK conversation between homes. This module owns:
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
  /** Whether a fresh session on an unadopted branch should use a branch home. */
  enabledForNewSessions: boolean;
} {
  const mode: SdkHomeMode = config.execution?.sandbox?.sdk_home_mode ?? 'inherit';
  return { mode, enabledForNewSessions: mode === 'per_branch' };
}

/**
 * Whether local execution has the two boundaries required for a caller-scoped
 * native credential overlay: bubblewrap is enabled, and the caller has a
 * durable private home from which the daemon can pin `auth.json` by inode.
 * Functional `--bind-fd` support and bubblewrap's 0.12 setup-path fix are
 * enforced by the sandbox availability probe at spawn time.
 */
export function hasSecureLocalCredentialOverlay(config: Pick<AgorConfig, 'execution'>): boolean {
  return (
    config.execution?.sandbox?.enabled === true &&
    config.execution?.sandbox?.home_mode === 'per_user'
  );
}

/**
 * Decide the immutable SDK-state boundary for a newly created session.
 *
 * A genealogical child may explicitly inherit its parent's scope because it
 * continues the parent's SDK lineage. Every independent Session follows the
 * branch's sticky intent first, then the live deployment default. `adoptBranch`
 * lets the caller persist branch intent in the same transaction as Session
 * creation.
 */
export function resolveNewSessionSdkHomeScope(input: {
  branchSdkHomeIntent: 'per_branch' | null;
  enabledForNewSessions: boolean;
  inheritedScope?: SessionSdkHomeScope;
}): { scope: SessionSdkHomeScope; adoptBranch: boolean } {
  if (input.inheritedScope) {
    return { scope: input.inheritedScope, adoptBranch: false };
  }
  if (input.branchSdkHomeIntent === 'per_branch') {
    return { scope: 'branch', adoptBranch: false };
  }
  return input.enabledForNewSessions
    ? { scope: 'branch', adoptBranch: true }
    : { scope: 'execution_home', adoptBranch: false };
}

/**
 * Resolve the executor-time compatibility seam.
 *
 * Branch intent owns lifecycle and is the default for future sessions, while
 * the session stamp owns resume behavior. Therefore an execution-home session
 * deliberately ignores an adopted branch. A branch-scoped session without
 * matching branch intent is corrupt metadata and must fail closed rather than
 * silently resuming from a different home.
 */
export function sessionUsesBranchSdkHome(input: {
  sessionScope: SessionSdkHomeScope | undefined;
  branchSdkHomeIntent: 'per_branch' | null;
}): boolean {
  // Undefined is tolerated only as a defensive rolling-upgrade/test-fixture
  // fallback and chooses the non-sharing historical behavior.
  if ((input.sessionScope ?? 'execution_home') === 'execution_home') return false;
  if (input.branchSdkHomeIntent !== 'per_branch') {
    throw new Error(
      'Branch-scoped session references a branch without branch SDK-home intent; refusing fallback.'
    );
  }
  return true;
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
  /** Local sandbox can project a caller credential through a pinned fd bind. */
  secureLocalCredentialOverlay: boolean;
  auth?: { useNativeAuth: boolean; apiKey?: string };
}): string | undefined {
  if (
    input.tool === 'codex' &&
    !input.delegated &&
    input.auth?.useNativeAuth === true &&
    !input.auth.apiKey &&
    !input.secureLocalCredentialOverlay
  ) {
    return (
      'local Codex subscription auth requires the fail-closed per-user sandbox credential ' +
      'overlay; enable sandbox home_mode=per_user, switch Codex to an API key, use a reviewed ' +
      'delegated launcher, or use a branch without a per-branch SDK home'
    );
  }
  return undefined;
}

/**
 * Resolve the complete actor-sensitive compatibility policy at an admission
 * or launch boundary. Keeping the credential lookup beside the static tool
 * policy prevents Session, scheduler, and executor paths from drifting.
 */
export async function resolveBranchSdkHomeCompatibility(input: {
  tool: AgenticToolName;
  delegated: boolean;
  secureLocalCredentialOverlay: boolean;
  userId?: UserID;
  db: NonNullable<KeyResolutionContext['db']>;
}): Promise<{
  unsupportedReason?: string;
  /** Launch must project this caller's native Codex auth file by pinned fd. */
  requiresLocalCodexAuthOverlay: boolean;
}> {
  const toolReason = branchSdkHomeUnsupportedReason(input.tool);
  if (toolReason) return { unsupportedReason: toolReason, requiresLocalCodexAuthOverlay: false };

  const localCodexAuth =
    input.tool === 'codex' && !input.delegated
      ? await resolveApiKey('OPENAI_API_KEY', {
          userId: input.userId,
          db: input.db,
          tool: 'codex',
        })
      : undefined;
  const unsupportedReason = branchSdkHomeAuthUnsupportedReason({
    tool: input.tool,
    delegated: input.delegated,
    secureLocalCredentialOverlay: input.secureLocalCredentialOverlay,
    auth: localCodexAuth,
  });
  const requiresLocalCodexAuthOverlay =
    input.tool === 'codex' &&
    !input.delegated &&
    localCodexAuth?.useNativeAuth === true &&
    !localCodexAuth.apiKey;
  return {
    ...(unsupportedReason ? { unsupportedReason } : {}),
    requiresLocalCodexAuthOverlay,
  };
}

/** Reason-only compatibility adapter used by metadata admission paths. */
export async function resolveBranchSdkHomeIncompatibility(
  input: Parameters<typeof resolveBranchSdkHomeCompatibility>[0]
): Promise<string | undefined> {
  return (await resolveBranchSdkHomeCompatibility(input)).unsupportedReason;
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
