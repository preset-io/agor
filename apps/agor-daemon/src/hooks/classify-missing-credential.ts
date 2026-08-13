/**
 * Before-create hook that reclassifies executor-scoped provider failures
 * without matching arbitrary provider stderr. It handles explicit credential
 * preflight failures and narrowly recognized zero-turn billing failures.
 */

import { TOOL_API_KEY_NAMES } from '@agor/agentic-tools';
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
import { hasExecutorRuntimeScope } from '../auth/executor-runtime-scope.js';

/** Fallback for consumers that render `content` raw (mobile, gateway, CLI).
 * The web UI renders its own copy from MissingCredentialPanel instead. */
function fallbackContent(toolDisplayName: string): string {
  return `This session needs to be connected to ${toolDisplayName} before it can run.`;
}

function providerCreditContent(toolDisplayName: string): string {
  return `This session's ${toolDisplayName} account needs available credit or quota before it can respond.`;
}

type ProviderFailureKind = 'missing_credential' | 'provider_credit_exhausted';

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
  return 'metadata' in record || 'type' in record || 'role' in record;
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
  const content =
    errorKind === 'missing_credential'
      ? fallbackContent(toolDisplayName)
      : providerCreditContent(toolDisplayName);

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

const PROVIDER_CREDIT_SIGNALS = [
  'insufficient_quota',
  'quota_exhausted',
  'billing_hard_limit_reached',
  'payment_required',
] as const;
const PROVIDER_CREDIT_SIGNAL_PATTERN = new RegExp(`\\b(?:${PROVIDER_CREDIT_SIGNALS.join('|')})\\b`);
const PROVIDER_ERROR_SEARCH_WINDOW = 500;

function textContent(content: Message['content'] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

function isProviderCreditFailure(
  tool: AgenticToolName,
  content: Message['content'] | undefined
): boolean {
  const text = textContent(content).toLowerCase();
  if (!text) return false;

  // Claude's SDK joins its error array with newlines. Bound each error's
  // search window instead of rejecting the whole joined response when one
  // error is long; this still avoids classifying arbitrary distant prose.
  return text.split(/\r?\n/).some((error) => {
    const searchWindow = error.slice(0, PROVIDER_ERROR_SEARCH_WINDOW);
    const isAnthropicCreditFailure =
      tool === 'claude-code' && /\bcredit balance is too low\b/.test(searchWindow);
    const hasStableCreditSignal = PROVIDER_CREDIT_SIGNAL_PATTERN.test(searchWindow);
    return isAnthropicCreditFailure || hasStableCreditSignal;
  });
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
    const isProviderFailureResult = data.metadata?.is_provider_failure_result === true;

    if (!isMissingCredentialFailure && !isZeroTurnResult && !isProviderFailureResult) {
      return context;
    }

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

        if (!isProviderCreditFailure(tool, data.content)) return context;

        context.data = classifyProviderFailure(
          data,
          tool,
          toolDisplayNames[tool] ?? tool,
          'provider_credit_exhausted'
        );
        return context;
      }

      // Normalize both pathways onto system/SYSTEM so the UI has one render branch.
      context.data = classifyProviderFailure(
        data,
        tool,
        toolDisplayNames[tool] ?? tool,
        'missing_credential'
      );
    } catch (err) {
      console.error('[classifyMissingCredentialFailure] classification failed:', err);
    }

    return context;
  };
}
