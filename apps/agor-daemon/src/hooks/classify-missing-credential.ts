/**
 * Before-create hook that reclassifies a task failure as "missing credential"
 * without matching the provider's raw stderr. Fires on two failure shapes —
 * an explicit executor credential-preflight failure and a zero-turn "success"
 * whose current scoped connection resolves no credential.
 */

import { resolveApiKey } from '@agor/core/config';
import type { SessionRepository, TaskRepository, TenantScopeAwareDatabase } from '@agor/core/db';
import type { AgenticToolName, HookContext, Message, TaskID, UserID } from '@agor/core/types';
import {
  canonicalTenantAgenticTool,
  MessageRole,
  PROVIDER_CREDENTIAL_FIELDS,
  TOOL_API_KEY_NAMES,
} from '@agor/core/types';
import { hasExecutorRuntimeScope } from '../auth/executor-runtime-scope.js';

/** Fallback for consumers that render `content` raw (mobile, gateway, CLI).
 * The web UI renders its own copy from MissingCredentialPanel instead. */
function fallbackContent(toolDisplayName: string): string {
  return `This session needs to be connected to ${toolDisplayName} before it can run.`;
}

function hasResolvedCredential(
  tool: AgenticToolName,
  connection: Record<string, string | undefined> | undefined
): boolean {
  const canonicalTool = canonicalTenantAgenticTool(tool);
  if (!(canonicalTool in PROVIDER_CREDENTIAL_FIELDS)) return false;
  return PROVIDER_CREDENTIAL_FIELDS[canonicalTool as keyof typeof PROVIDER_CREDENTIAL_FIELDS].some(
    (field) => connection?.[field]?.trim()
  );
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
    if (!hasExecutorRuntimeScope(context)) return context;

    const isMissingCredentialFailure = data.metadata?.is_missing_credential_failure === true;
    const isZeroTurnResult = data.metadata?.is_zero_turn_result === true;

    if (!isMissingCredentialFailure && !isZeroTurnResult) return context;

    try {
      const [task, session] = await Promise.all([
        taskRepository.findById(data.task_id as TaskID),
        sessionsRepository.findById(data.session_id),
      ]);
      if (!task || !session) return context;
      if (task.session_id !== data.session_id || session.session_id !== data.session_id) {
        return context;
      }

      const tool = session.agentic_tool;
      const keyName = TOOL_API_KEY_NAMES[tool];
      // Tools with no mapped key (e.g. opencode) aren't credential-gated.
      if (!keyName) return context;

      if (isZeroTurnResult && !isMissingCredentialFailure) {
        const resolution = await resolveApiKey(keyName, {
          userId: task.created_by as UserID,
          db,
          tool,
        });
        if (
          resolution.apiKey ||
          resolution.useNativeAuth ||
          hasResolvedCredential(tool, resolution.connection)
        ) {
          return context;
        }
      }

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
