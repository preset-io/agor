/**
 * Before-create hook on the `messages` service that classifies a task's
 * failure notice as a "missing credential" failure — without ever matching
 * the underlying error text (which is a raw passthrough of the provider
 * CLI/SDK's stderr and is fragile to upstream wording changes).
 *
 * Detection reuses `resolveApiKey` — the exact same resolution chain
 * (per-user encrypted key -> config.yaml -> env var -> native CLI/OAuth)
 * that `apps/agor-daemon/src/services/check-auth.ts` uses for the
 * onboarding wizard's "Test Connection" button. If the task already failed
 * while attempting the native-auth fallback, that failed attempt IS the
 * proof native auth doesn't work — so no second SDK probe is needed here.
 *
 * Only acts on messages the executor marks with `metadata.is_task_failure`
 * (see `packages/executor/src/handlers/sdk/base-executor.ts`), so unrelated
 * system messages (daemon restart, rate limit, etc.) are never touched.
 */

import { resolveApiKey } from '@agor/core/config';
import {
  type SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { HookContext, Message, TaskID, UserID } from '@agor/core/types';
import { TOOL_API_KEY_NAMES } from '@agor/core/types';

/** Friendly, jargon-free fallback for any consumer that renders `content`
 * raw without checking `metadata.error_kind` (mobile app, gateway relays,
 * CLI `agor session get`, etc). The web UI renders its own copy from the
 * MissingCredentialPanel component instead of this string. */
function fallbackContent(toolDisplayName: string): string {
  return `This session needs to be connected to ${toolDisplayName} before it can run.`;
}

export function classifyMissingCredentialFailure(
  db: TenantScopeAwareDatabase,
  sessionsRepository: Pick<SessionRepository, 'findById'>,
  toolDisplayNames: Record<string, string>
) {
  const taskRepo = new TaskRepository(db);

  return async (context: HookContext): Promise<HookContext> => {
    const data = context.data as Partial<Message> | undefined;
    if (!data?.metadata?.is_task_failure || !data.task_id || !data.session_id) {
      return context;
    }

    try {
      const [task, session] = await Promise.all([
        taskRepo.findById(data.task_id as TaskID),
        sessionsRepository.findById(data.session_id),
      ]);
      if (!task || !session) return context;

      const tool = session.agentic_tool;
      const keyName = TOOL_API_KEY_NAMES[tool];
      // Tools with no mapped key (opencode: always ready; anything
      // unmapped/future: a structurally different problem) fall through
      // untouched to the existing generic failure handling.
      if (!keyName) return context;

      const { apiKey } = await resolveApiKey(keyName, {
        userId: task.created_by as UserID,
        db,
        tool,
      });
      if (apiKey) return context; // A credential DID resolve — some other failure.

      context.data = {
        ...data,
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
