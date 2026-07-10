/**
 * Before-create hook on the `messages` service that reclassifies a task
 * failure as "missing credential" by re-running `resolveApiKey` — the same
 * resolution chain (per-user key -> config.yaml -> env var -> native
 * CLI/OAuth) that check-auth.ts uses. Detection is structural: it never
 * matches the provider's raw stderr, which is a fragile passthrough of
 * upstream wording.
 *
 * Two pathways report "no credential" and both are caught:
 * 1. Thrown error — base-executor.ts patches the task to `failed` and emits a
 *    `system` message marked `metadata.is_task_failure`.
 * 2. Zero-token "success" — the claude CLI can return `subtype: 'success'`
 *    whose text IS the auth-failure message, synthesized into a plain
 *    `assistant` message with zero tokens.
 *
 * The zero-token condition only gates WHETHER to run the resolveApiKey check;
 * the resolve result alone decides the outcome. Zero tokens is not unique to
 * auth failures (local slash-command output like `/cost` is zero-token too),
 * so an authenticated user's key still resolves and the message is left
 * untouched.
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
  toolDisplayNames: Record<string, string>
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
      // Tools with no mapped key (opencode, or anything future/unmapped) fall
      // through untouched to the existing generic failure handling.
      if (!keyName) return context;

      const { apiKey } = await resolveApiKey(keyName, {
        userId: task.created_by as UserID,
        db,
        tool,
      });
      if (apiKey) return context; // A credential DID resolve — some other failure.

      context.data = {
        ...data,
        // Normalize both pathways onto `system`/SYSTEM so the UI needs one
        // render branch. The zero-token message was typed `assistant` (it was
        // synthesized from the SDK result text), but was never a real reply.
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
