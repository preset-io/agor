/**
 * Before-create hook on the `messages` service that classifies a task's
 * failure as a "missing credential" failure — without ever matching the
 * underlying error text (which is a raw passthrough of the provider
 * CLI/SDK's stderr and is fragile to upstream wording changes).
 *
 * Detection reuses `resolveApiKey` — the exact same resolution chain
 * (per-user encrypted key -> config.yaml -> env var -> native CLI/OAuth)
 * that `apps/agor-daemon/src/services/check-auth.ts` uses for the
 * onboarding wizard's "Test Connection" button. If the task already failed
 * while attempting the native-auth fallback, that failed attempt IS the
 * proof native auth doesn't work — so no second SDK probe is needed here.
 *
 * There are two structurally distinct ways a provider CLI/SDK reports "no
 * credential" back to the executor, and this hook has to catch both:
 *
 * 1. **Thrown error** — the SDK call throws, `base-executor.ts`'s catch
 *    block patches the task to `failed` and creates a `system`-role message
 *    marked `metadata.is_task_failure` with the raw error text as content.
 * 2. **Zero-token "success"** — the claude CLI can return a normal
 *    `subtype: 'success'` result whose `result` text IS the auth-failure
 *    message, with zero real assistant turns and zero tokens consumed (see
 *    `message-processor.ts`'s `handleResult()`: when a result event carries
 *    text but produced no streamed assistant messages, that text gets
 *    synthesized into a plain `assistant`-role message — the same code path
 *    used for local slash-command output like `/cost`). The task completes
 *    normally; nothing throws.
 *
 * Case 2 has no explicit "this failed" marker to key off of, so detection
 * falls back to a structural proxy: a real successful Claude turn always
 * consumes tokens (the system prompt alone costs hundreds), so an
 * `assistant` message with `metadata.tokens.input === 0 &&
 * metadata.tokens.output === 0` is a reliable signal that no real model
 * call happened. That signal is NOT unique to auth failures — local
 * slash-command output is zero-token too — so it is only ever used to
 * decide whether to *run* the resolveApiKey check, never to decide the
 * outcome. An authenticated user's `/cost` output still has a credential
 * resolve, so the hook leaves it untouched; only a genuine no-credential
 * session gets reclassified. This keeps detection fully structural (SDK
 * facts + the same resolution chain used elsewhere), never text-matching.
 */

import { resolveApiKey } from '@agor/core/config';
import type { SessionRepository, TaskRepository, TenantScopeAwareDatabase } from '@agor/core/db';
import type { HookContext, Message, TaskID, UserID } from '@agor/core/types';
import { MessageRole, TOOL_API_KEY_NAMES } from '@agor/core/types';

/** Friendly, jargon-free fallback for any consumer that renders `content`
 * raw without checking `metadata.error_kind` (mobile app, gateway relays,
 * CLI `agor session get`, etc). The web UI renders its own copy from the
 * MissingCredentialPanel component instead of this string. */
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
    const isUnverifiedZeroTokenSuccess =
      data.type === 'assistant' &&
      data.role === MessageRole.ASSISTANT &&
      data.metadata?.tokens?.input === 0 &&
      data.metadata?.tokens?.output === 0;

    if (!isThrownFailureNotice && !isUnverifiedZeroTokenSuccess) return context;

    try {
      const [task, session] = await Promise.all([
        taskRepository.findById(data.task_id as TaskID),
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
        // Normalize both pathways onto `system`/SYSTEM: the zero-token
        // pathway's message is currently typed `assistant` (it was
        // synthesized from the SDK result text as if it were a real reply),
        // but it was never actually the assistant talking — same as the
        // thrown-error pathway, this is a system-level notice. Unifying
        // both here means the UI only needs one render branch
        // (`MessageBlock`'s `isSystem && error_kind === 'missing_credential'`
        // check) regardless of which SDK pathway produced it.
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
