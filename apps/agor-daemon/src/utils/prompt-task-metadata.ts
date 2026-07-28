import type { MessageSource, TaskMetadata } from '@agor/core/types';

/** Caller-supplied prompt metadata may not claim transport provenance. */
export type PromptTaskMetadataInput = Omit<Partial<TaskMetadata>, 'source'>;

/**
 * Merge caller metadata with daemon-owned provenance.
 *
 * The defensive source removal is intentional even though the public DTO
 * excludes it: stale/untyped clients can still place arbitrary JSON on the
 * wire. Daemon-owned fields are applied last so callers cannot override them.
 */
export function buildPromptTaskMetadata(
  input: PromptTaskMetadataInput | undefined,
  source: MessageSource | undefined,
  queuedByUserId?: string
): TaskMetadata {
  const { source: _discardedSource, ...safeInput } = (input ?? {}) as Partial<TaskMetadata>;
  return {
    ...safeInput,
    ...(queuedByUserId ? { queued_by_user_id: queuedByUserId } : {}),
    ...(source ? { source } : {}),
  };
}
