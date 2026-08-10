import type { GatewayTaskOrigin, MessageSource, Params, TaskMetadata } from '@agor/core/types';

/** Internal prompt producers may request non-provenance Task metadata. */
export type InternalPromptTaskMetadataInput = Omit<
  Partial<TaskMetadata>,
  'source' | 'gateway_origin' | 'initial_message_id' | 'completion_callback'
>;

export function normalizeMessageSource(
  input: MessageSource | undefined,
  params: Params
): MessageSource | undefined {
  if (params.provider) return 'agor';
  return input === 'gateway' || input === 'agor' ? input : undefined;
}

/**
 * Merge caller metadata with daemon-owned provenance.
 *
 * The defensive removals are intentional even though the public DTO excludes
 * these fields: stale or untyped clients can still place arbitrary JSON on the
 * wire. Daemon-owned fields are applied separately by trusted service paths.
 */
export function buildPromptTaskMetadata(
  input: InternalPromptTaskMetadataInput | undefined,
  source: MessageSource | undefined,
  queuedByUserId: string | undefined,
  options: { trustedInternalMetadata: boolean; gatewayOrigin?: GatewayTaskOrigin }
): TaskMetadata {
  const {
    source: _discardedSource,
    gateway_origin: _discardedOrigin,
    initial_message_id: _discardedInitialMessageId,
    completion_callback: _discardedCallback,
    ...safeInput
  } = (input ?? {}) as Partial<TaskMetadata>;
  return {
    ...(options.trustedInternalMetadata ? safeInput : {}),
    ...(queuedByUserId ? { queued_by_user_id: queuedByUserId } : {}),
    ...(source ? { source } : {}),
    ...(options.gatewayOrigin ? { gateway_origin: options.gatewayOrigin } : {}),
  };
}
