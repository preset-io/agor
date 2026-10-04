import type { MessageSource, TaskMetadata } from '@agor/core/types';

/** Internal prompt producers may request daemon-owned provenance fields. */
export type InternalPromptTaskMetadataInput = Omit<
  Partial<TaskMetadata>,
  'source' | 'initial_message_id' | 'completion_callback' | 'prompt_provenance'
>;

/**
 * Merge caller metadata with daemon-owned provenance.
 *
 * The defensive removals are intentional even though the public DTO excludes
 * these fields: stale/untyped clients can still place arbitrary JSON on the
 * wire. Daemon-owned fields are applied separately by trusted service paths.
 *
 * `prompt_provenance` is discarded unconditionally - including from trusted
 * internal producers, which is strictly stronger than the treatment of
 * `source`. That is deliberate: a caller-supplied provenance field is worse
 * than none at all, because it launders an assertion into something that looks
 * server-attested. No producer may hand-assemble it; the admission route
 * applies it from `params._promptProvenance` and nowhere else.
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
    prompt_provenance: _discardedProvenance,
    ...safeInput
  } = (input ?? {}) as Partial<TaskMetadata>;
  return {
    ...(options.trustedInternalMetadata ? safeInput : {}),
    ...(queuedByUserId ? { queued_by_user_id: queuedByUserId } : {}),
    ...(source ? { source } : {}),
  };
}
