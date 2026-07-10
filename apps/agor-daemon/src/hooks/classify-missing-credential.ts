/**
 * Before-create hook that reclassifies a task failure as "missing credential"
 * via `resolveApiKey`, never by matching the provider's raw stderr. Fires on
 * two failure shapes — a thrown error (`is_task_failure`) and a zero-turn
 * "success" whose text is the auth error (`is_zero_turn_result`) — then lets
 * the resolve result (plus a native-auth probe) decide the outcome.
 */

import { resolveApiKey } from '@agor/core/config';
import type { SessionRepository, TaskRepository, TenantScopeAwareDatabase } from '@agor/core/db';
import type { HookContext, Message, TaskID, UserID } from '@agor/core/types';
import { MessageRole, TOOL_API_KEY_NAMES } from '@agor/core/types';

/** Fallback for consumers that render `content` raw (mobile, gateway, CLI).
 * The web UI renders its own copy from MissingCredentialPanel instead. */
function fallbackContent(toolDisplayName: string): string {
  return `This session needs to be connected to ${toolDisplayName} before it can run.`;
}

export function classifyMissingCredentialFailure(
  db: TenantScopeAwareDatabase,
  taskRepository: Pick<TaskRepository, 'findById'>,
  sessionsRepository: Pick<SessionRepository, 'findById'>,
  toolDisplayNames: Record<string, string>,
  // Injected (not imported) so the hook stays free of the Claude SDK's import
  // graph, which breaks under vitest's ESM resolution.
  probeNativeAuth?: (tool: string) => Promise<boolean>
) {
  return async (context: HookContext): Promise<HookContext> => {
    const data = context.data as Partial<Message> | undefined;
    if (!data?.task_id || !data.session_id) return context;

    const isThrownFailureNotice = data.metadata?.is_task_failure === true;
    const isZeroTurnResult = data.metadata?.is_zero_turn_result === true;

    if (!isThrownFailureNotice && !isZeroTurnResult) return context;

    try {
      const [task, session] = await Promise.all([
        taskRepository.findById(data.task_id as TaskID),
        sessionsRepository.findById(data.session_id),
      ]);
      if (!task || !session) return context;

      const tool = session.agentic_tool;
      const keyName = TOOL_API_KEY_NAMES[tool];
      // Tools with no mapped key (e.g. opencode) aren't credential-gated.
      if (!keyName) return context;

      const { apiKey, useNativeAuth } = await resolveApiKey(keyName, {
        userId: task.created_by as UserID,
        db,
        tool,
      });
      if (apiKey) return context; // A credential DID resolve — some other failure.

      // Native-auth tools resolve to no key even when logged in via CLI/OAuth;
      // probe the live auth state before concluding it's actually missing.
      if (useNativeAuth && probeNativeAuth && (await probeNativeAuth(tool))) return context;

      context.data = {
        ...data,
        // Normalize both pathways onto system/SYSTEM so the UI has one render branch.
        type: 'system',
        role: MessageRole.SYSTEM,
        content: fallbackContent(toolDisplayNames[tool] ?? tool),
        content_preview: fallbackContent(toolDisplayNames[tool] ?? tool).substring(0, 200),
        metadata: {
          ...data.metadata,
          error_kind: 'missing_credential',
          tool,
        },
      };
    } catch (err) {
      console.error('[classifyMissingCredentialFailure] classification failed:', err);
    }

    return context;
  };
}
