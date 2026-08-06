import type { MessageSource, TaskMetadata } from '@agor/core/types';

/** Internal prompt producers may request daemon-owned provenance fields. */
export type InternalPromptTaskMetadataInput = Omit<
  Partial<TaskMetadata>,
  'source' | 'initial_message_id'
>;

/**
 * Merge caller metadata with daemon-owned provenance.
 *
 * The defensive source removal is intentional even though the public DTO
 * excludes it: stale/untyped clients can still place arbitrary JSON on the
 * wire. Daemon-owned fields are applied last so callers cannot override them.
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
    ...safeInput
  } = (input ?? {}) as Partial<TaskMetadata>;
  return {
    ...(options.trustedInternalMetadata ? safeInput : {}),
    ...(queuedByUserId ? { queued_by_user_id: queuedByUserId } : {}),
    ...(source ? { source } : {}),
  };
}
