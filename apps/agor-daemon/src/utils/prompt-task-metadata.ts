import type { MessageSource, TaskMetadata } from '@agor/core/types';

/** Internal prompt producers may request daemon-owned provenance fields. */
export type InternalPromptTaskMetadataInput = Omit<
  Partial<TaskMetadata>,
  'source' | 'initial_message_id' | 'completion_callback'
>;

/**
 * Merge caller metadata with daemon-owned provenance.
 *
 * The defensive removals are intentional even though the public DTO excludes
 * these fields: stale/untyped clients can still place arbitrary JSON on the
 * wire. Daemon-owned fields are applied separately by trusted service paths.
 */
export function buildPromptTaskMetadata(
  input: InternalPromptTaskMetadataInput | undefined,
  source: MessageSource | undefined,
  queuedByUserId: string | undefined,
  options: { trustedInternalMetadata: boolean }
): TaskMetadata {
  const {
    source: _discardedSource,
    initial_message_id: _discardedInitialMessageId,
    completion_callback: _discardedCallback,
    ...safeInput
  } = (input ?? {}) as Partial<TaskMetadata>;
  return {
    ...(options.trustedInternalMetadata ? safeInput : {}),
    ...(queuedByUserId ? { queued_by_user_id: queuedByUserId } : {}),
    ...(source ? { source } : {}),
  };
}
