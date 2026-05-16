/**
 * Shared permission_config resolver used by `resolveSessionDefaults` (no
 * parent) and `resolveChildSessionConfig` (with parent).
 *
 * Both helpers walk the same precedence: request → (parent — only when the
 * caller passes one) → user default → mapped system default. The only
 * difference is whether a "parent layer" is interposed between the explicit
 * override and the user default. This module collapses that walk so the two
 * public resolvers don't drift on the codex sub-config edge cases.
 */

import type { ModelConfigInput } from '../models/resolve-config.js';
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
 * Common runtime overrides shared by every session-creation flow. Per-flow
 * extensions (e.g. `SessionDefaultsOverrides` adds `mcpServerIds`) extend
 * this base.
 */
export interface SessionRuntimeOverrides {
  permissionMode?: PermissionMode;
  modelConfig?: ModelConfigInput;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: CodexNetworkAccess;
}

/**
 * Optional "parent layer" interposed between explicit overrides and user
 * defaults. Only the fields a parent can carry forward are present. The
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
  overrides?: SessionRuntimeOverrides;
  userToolDefaults?: DefaultAgenticToolConfig;
  /** When present, layered between explicit override and user default. */
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
 * override / parent / user layers is filled from `mapToCodexPermissionConfig`
 * keyed off the resolved permission mode. This prevents partial user
 * overrides (e.g. just `codexApprovalPolicy: 'untrusted'`) from being
 * silently dropped and then escalated to the relaxed system default by the
 * executor's last-line fallback.
 */
export function resolvePermissionConfig(
  args: ResolvePermissionConfigArgs
): NonNullable<Session['permission_config']> {
  const { effectiveTool, overrides, userToolDefaults, parentLayer } = args;

  const requestedMode: PermissionMode =
    overrides?.permissionMode ??
    parentLayer?.permissionMode ??
    userToolDefaults?.permissionMode ??
    getDefaultPermissionMode(effectiveTool);

  const effectiveMode: PermissionMode = mapPermissionMode(requestedMode, effectiveTool);
  const out: NonNullable<Session['permission_config']> = { mode: effectiveMode };

  if (effectiveTool === 'codex') {
    const sandboxMode =
      overrides?.codexSandboxMode ??
      parentLayer?.codexSandboxMode ??
      userToolDefaults?.codexSandboxMode;
    const approvalPolicy =
      overrides?.codexApprovalPolicy ??
      parentLayer?.codexApprovalPolicy ??
      userToolDefaults?.codexApprovalPolicy;
    const networkAccess =
      overrides?.codexNetworkAccess !== undefined
        ? overrides.codexNetworkAccess
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
