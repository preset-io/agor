/**
 * Before-create hook that reclassifies executor-scoped provider failures
 * without matching arbitrary provider stderr. It handles explicit credential
 * preflight failures and provider-result messages whose credential state can
 * be resolved authoritatively. Arbitrary provider prose is never classified.
 */

import { TOOL_API_KEY_NAMES } from '@agor/agentic-tools';
import { SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE } from '@agor/core';
import { resolveApiKey } from '@agor/core/config';
import type { SessionRepository, TaskRepository, TenantScopeAwareDatabase } from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import type {
  AgenticToolName,
  HookContext,
  Message,
  MessageID,
  TaskID,
  UserID,
} from '@agor/core/types';
import {
  canonicalTenantAgenticTool,
  isAgenticToolName,
  MessageRole,
  PROVIDER_CREDENTIAL_FIELDS,
} from '@agor/core/types';
import {
  authenticatedTaskExecutorRuntimeScope,
  matchesTaskExecutorRuntimeScope,
} from '../auth/executor-runtime-scope.js';

/** Fallback for consumers that render `content` raw (mobile, gateway, CLI).
 * The web UI renders its own copy from MissingCredentialPanel instead. */
function fallbackContent(toolDisplayName: string): string {
  return `This session needs to be connected to ${toolDisplayName} before it can run.`;
}

type ProviderFailureKind = 'missing_credential';

export type ProviderFailureMessageLoader = (messageId: MessageID) => Promise<Message | null>;

function declaresProviderFailure(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const metadata = (data as { metadata?: unknown }).metadata;
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    'error_kind' in metadata
  );
}

/** Reject public single/bulk DTOs that attempt to mint daemon-owned recovery states. */
export function assertExternalProviderFailureMetadataAllowed(data: unknown): void {
  const writes = Array.isArray(data) ? data : [data];
  if (writes.some(declaresProviderFailure)) {
    throw new Forbidden('Provider failure metadata can only be classified by the daemon');
  }
}

function changesProviderFailureOwnedFields(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return (
    'metadata' in record ||
    'type' in record ||
    'role' in record ||
    'content' in record ||
    'content_preview' in record
  );
}

/**
 * Keep the recovery-panel discriminator and its render gate owned by daemon
 * classification. Public patching uses a shallow repository merge, so an
 * otherwise harmless-looking metadata/type/role patch could erase or hide a
 * trusted classification unless the existing record is checked first.
 */
export function protectExternalProviderFailureMetadata(loadMessage: ProviderFailureMessageLoader) {
  return async (context: HookContext): Promise<HookContext> => {
    if (!context.params.provider) return context;
    assertExternalProviderFailureMetadataAllowed(context.data);

    if (context.method !== 'patch' || context.id === null || context.id === undefined) {
      return context;
    }
    if (!changesProviderFailureOwnedFields(context.data)) return context;

    const existing = await loadMessage(String(context.id) as MessageID);
    if (existing && declaresProviderFailure(existing)) {
      throw new Forbidden('Provider failure classification is daemon-owned');
    }
    return context;
  };
}

function classifyProviderFailure(
  data: Partial<Message>,
  tool: AgenticToolName,
  toolDisplayName: string,
  errorKind: ProviderFailureKind
): Partial<Message> {
  const content = fallbackContent(toolDisplayName);

  return {
    ...data,
    type: 'system',
    role: MessageRole.SYSTEM,
    content,
    content_preview: content.substring(0, 200),
    metadata: {
      ...data.metadata,
      error_kind: errorKind,
      tool,
    },
  };
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
    let data = context.data as Partial<Message> | undefined;
    if (!data?.task_id || !data.session_id) return context;
    const taskId = data.task_id as TaskID;
    const sessionId = data.session_id;
    const executorScope = authenticatedTaskExecutorRuntimeScope(context.params);
    if (!executorScope) return context;

    const isMissingCredentialFailure = data.metadata?.is_missing_credential_failure === true;
    const isZeroTurnResult = data.metadata?.is_zero_turn_result === true;
    const isProviderFailureResult = data.metadata?.is_provider_failure_result === true;

    if (!isMissingCredentialFailure && !isZeroTurnResult && !isProviderFailureResult) {
      return context;
    }
    if (!matchesTaskExecutorRuntimeScope(executorScope, data)) {
      throw new Forbidden('Provider failure classification requires this task executor');
    }

    // Provider result bodies are untrusted and this hook runs immediately
    // before persistence/realtime publication. Close the body before any DB or
    // credential lookup which can fail. Missing-credential classification may
    // replace this fixed fallback below; no other provider prose is retained.
    if (isZeroTurnResult || isProviderFailureResult) {
      data = {
        ...data,
        content: SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
        content_preview: SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE.substring(0, 200),
      };
      context.data = data;
    }

    try {
      const [task, session] = await Promise.all([
        taskRepository.findById(taskId),
        sessionsRepository.findById(sessionId),
      ]);
      if (!task || !session) return context;
      if (task.session_id !== sessionId || session.session_id !== sessionId) {
        return context;
      }

      const tool = session.agentic_tool;
      if (!isAgenticToolName(tool)) return context;
      const keyName = TOOL_API_KEY_NAMES[tool];
      // Tools with no mapped key (e.g. opencode) aren't credential-gated.
      if (!keyName) return context;

      if ((isZeroTurnResult || isProviderFailureResult) && !isMissingCredentialFailure) {
        const resolution = await resolveApiKey(keyName, {
          userId: task.created_by as UserID,
          db,
          tool,
        });

        const hasCredential =
          resolution.apiKey ||
          resolution.useNativeAuth ||
          hasResolvedCredential(tool, resolution.connection);
        if (!hasCredential) {
          // Missing credential wins over any provider text in the synthesized
          // result: the scoped resolver is the source of truth here.
          context.data = classifyProviderFailure(
            data,
            tool,
            toolDisplayNames[tool] ?? tool,
            'missing_credential'
          );
          return context;
        }

        // Claude/Codex provider result strings have no typed billing/auth
        // discriminator. Parsing arbitrary prose here would both reintroduce a
        // secret-reflection boundary and claim recovery state we cannot prove.
        // Keep the fixed generic provider-result fallback.
        return context;
      }

      // Normalize both pathways onto system/SYSTEM so the UI has one render branch.
      context.data = classifyProviderFailure(
        data,
        tool,
        toolDisplayNames[tool] ?? tool,
        'missing_credential'
      );
    } catch {
      console.error('[classifyMissingCredentialFailure] classification failed');
    }

    return context;
  };
}
