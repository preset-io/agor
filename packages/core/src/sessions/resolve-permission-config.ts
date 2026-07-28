/**
 * Shared permission_config resolver used by `resolveSessionDefaults` (no
 * parent) and `resolveChildSessionConfig` (with parent).
 *
 * Both helpers walk the same precedence: selected source → same-tool parent
 * → execution owner → mapped system default. This module collapses that walk
 * so the public resolvers don't drift on Codex sub-config edge cases.
 */

import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexNetworkAccess,
  CodexSandboxMode,
  DefaultAgenticToolConfig,
  PermissionMode,
  Session,
} from '../types/index.js';
import { getDefaultPermissionMode } from '../types/session.js';
import { mapPermissionMode, mapToCodexPermissionConfig } from '../utils/permission-mode-mapper.js';

/**
 * Optional same-tool parent layer between the source and execution owner.
 * Only the fields a parent can carry forward are present. The
 * caller (the child-session resolver) is responsible for gating this on
 * tool match — passing `undefined` means "no parent layer applies."
 */
export interface ParentPermissionLayer {
  permissionMode?: PermissionMode;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: CodexNetworkAccess;
}

export interface ResolvePermissionConfigArgs {
  effectiveTool: AgenticToolName;
  source?: DefaultAgenticToolConfig | null;
  userToolDefaults?: DefaultAgenticToolConfig;
  /** When present, layered after the selected source and before the owner default. */
  parentLayer?: ParentPermissionLayer;
}

/**
 * Resolve `permission_config` for a session being created, with consistent
 * precedence whether or not a parent layer is supplied. Always returns a
 * populated object — the system default mapped through `mapPermissionMode`
 * is the final fallback.
 *
 * For `codex` sessions, the sub-config (`sandboxMode` + `approvalPolicy` +
 * `networkAccess`) is ALWAYS emitted. Any field not provided by the
 * source / parent / owner layers is filled from
 * `mapToCodexPermissionConfig` keyed off the resolved permission mode. This
 * prevents partial user overrides (e.g. just `codexApprovalPolicy:
 * 'untrusted'`) from being silently dropped and then escalated to the relaxed
 * system default by the executor's last-line fallback.
 */
export function resolvePermissionConfig(
  args: ResolvePermissionConfigArgs
): NonNullable<Session['permission_config']> {
  const { effectiveTool, source, userToolDefaults, parentLayer } = args;

  const requestedMode: PermissionMode =
    source?.permissionMode ??
    parentLayer?.permissionMode ??
    userToolDefaults?.permissionMode ??
    getDefaultPermissionMode(effectiveTool);

  const effectiveMode: PermissionMode = mapPermissionMode(requestedMode, effectiveTool);
  const out: NonNullable<Session['permission_config']> = { mode: effectiveMode };

  if (effectiveTool === 'codex') {
    const sandboxMode =
      source?.codexSandboxMode ??
      parentLayer?.codexSandboxMode ??
      userToolDefaults?.codexSandboxMode;
    const approvalPolicy =
      source?.codexApprovalPolicy ??
      parentLayer?.codexApprovalPolicy ??
      userToolDefaults?.codexApprovalPolicy;
    const networkAccess =
      source?.codexNetworkAccess !== undefined
        ? source.codexNetworkAccess
        : parentLayer?.codexNetworkAccess !== undefined
          ? parentLayer.codexNetworkAccess
          : userToolDefaults?.codexNetworkAccess;

    const defaults = mapToCodexPermissionConfig(effectiveMode);
    out.codex = {
      sandboxMode: sandboxMode ?? defaults.sandboxMode,
      approvalPolicy: approvalPolicy ?? defaults.approvalPolicy,
      networkAccess: networkAccess ?? defaults.networkAccess,
    };
  }

  return out;
}
