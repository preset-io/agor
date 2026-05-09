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
import { mapPermissionMode } from '../utils/permission-mode-mapper.js';

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
 * Codex's dual sub-config (`sandboxMode` + `approvalPolicy` + `networkAccess`)
 * is emitted only on `codex` sessions, and only when both required fields
 * resolve to a value.
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

  const out: NonNullable<Session['permission_config']> = {
    mode: mapPermissionMode(requestedMode, effectiveTool),
  };

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

    if (sandboxMode && approvalPolicy) {
      out.codex = {
        sandboxMode,
        approvalPolicy,
        ...(networkAccess !== undefined && { networkAccess }),
      };
    }
  }

  return out;
}
