/**
 * Before-create hook that auto-fills `permission_config` and `model_config`
 * from the creator's `default_agentic_config[tool]` when the caller omits them.
 *
 * Why this hook exists
 * --------------------
 * Multiple session-creation paths (MCP `agor_sessions_create`, MCP
 * `agor_worktrees_set_zone`, gateway, the UI drag-into-zone handler, raw
 * REST) used to each carry their own copy of the "fetch user → read tool
 * defaults → resolve permission mode → build permission_config" dance. The UI
 * drag handler shipped without it (issue #1064), so dragged sessions were
 * created with `permission_config: null` — which Claude Code interprets as
 * the most restrictive mode and which made every dragged session hang
 * waiting for manual approval.
 *
 * Centralizing the resolution as a `before:create` hook means:
 *  - Every caller benefits, including future ones.
 *  - Callers that DO want to set explicit config (MCP tools with `modelConfig`
 *    args, gateway with channel-level config, spawn/fork with parent
 *    inheritance) just pre-populate the field — the hook leaves populated
 *    fields untouched.
 *
 * The shared resolution logic lives in `@agor/core/sessions`
 * ({@link resolveSessionDefaults}); this hook is just the FeathersJS adapter
 * around it.
 *
 * Caveats
 * -------
 *  - The hook ONLY fills `permission_config` and `model_config`. MCP server
 *    attachment is intentionally left to caller-side code because the
 *    "explicit-failures-must-surface" semantics differ between
 *    explicitly-requested servers (caller wants to know about failures) and
 *    inherited servers (best-effort, log-and-skip). See the open follow-up
 *    in `apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx`.
 *  - Internal calls (no `params.provider`) only resolve via `data.created_by`,
 *    so service-to-service callers must stamp it (or the helper falls back to
 *    the system default — same behavior as the bug today, just no longer
 *    reachable via REST/MCP/UI).
 */

import { resolveSessionDefaults } from '@agor/core/sessions';
import type { AgenticToolName, HookContext, Session, User } from '@agor/core/types';

interface UsersService {
  get: (id: string, params?: unknown) => Promise<User | null | undefined>;
}

/**
 * @param opts.warnOnExternalDefaultFill — when `true` (recommended in dev),
 *   logs a warning whenever an external (REST/socketio/MCP) caller omits
 *   `permission_config`. This surfaces lazy callers without breaking them.
 *   The hook still applies defaults; the warning is purely diagnostic.
 */
export interface ApplySessionConfigDefaultsOpts {
  warnOnExternalDefaultFill?: boolean;
}

export function applySessionConfigDefaults(opts: ApplySessionConfigDefaultsOpts = {}) {
  const { warnOnExternalDefaultFill = true } = opts;

  return async (context: HookContext): Promise<HookContext> => {
    if (Array.isArray(context.data)) {
      // Bulk create not supported for sessions; bail rather than guessing.
      return context;
    }
    const data = context.data as Partial<Session> | undefined;
    if (!data) return context;

    const hasPermission = data.permission_config != null;
    const hasModel = data.model_config != null;
    if (hasPermission && hasModel) return context; // nothing to fill

    const agenticTool = data.agentic_tool as AgenticToolName | undefined;
    if (!agenticTool) return context; // can't resolve defaults without a tool

    // Identify the user whose defaults to apply. External calls go through
    // injectCreatedBy() first, which stamps `data.created_by` from
    // `params.user.user_id`, so by the time we run, `created_by` is the
    // ground truth. Internal calls may set it explicitly or not at all.
    const userId = data.created_by;
    if (!userId) return context;

    let user: User | null | undefined;
    try {
      const usersService = context.app.service('users') as unknown as UsersService;
      // Bypass auth for the lookup — we're inside a hook on behalf of the
      // already-authenticated caller (or an internal call).
      user = await usersService.get(userId, { provider: undefined });
    } catch (err) {
      // If we can't load the user, fall back to system defaults (no user-tier
      // values) rather than failing the create.
      console.warn(
        `[apply-session-config-defaults] Failed to load user ${userId} for defaults:`,
        err instanceof Error ? err.message : String(err)
      );
      user = null;
    }

    const resolved = resolveSessionDefaults({ agenticTool, user });

    if (!hasPermission) {
      data.permission_config = resolved.permission_config;
      if (warnOnExternalDefaultFill && context.params.provider) {
        console.warn(
          `[apply-session-config-defaults] Filled missing permission_config for ${agenticTool} session ` +
            `(user=${userId}, provider=${context.params.provider}, mode=${resolved.permission_config.mode}). ` +
            `Caller should send permission_config explicitly.`
        );
      }
    }
    if (!hasModel && resolved.model_config) {
      data.model_config = resolved.model_config;
    }

    return context;
  };
}
