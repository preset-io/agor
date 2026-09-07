import { BadRequest, Forbidden } from '@agor/core/feathers';

/**
 * Stable domain signal for Knowledge optimistic-concurrency failures.
 *
 * Callers that can safely retry must use this type rather than matching the
 * user-facing message, which may change independently of retry behavior.
 */
export class KnowledgeDocumentVersionMismatchError extends BadRequest {
  constructor(
    public readonly expectedVersion: string | number,
    public readonly currentVersion: string | number | 'none'
  ) {
    super(
      `Knowledge document version mismatch: expected ${expectedVersion}, current is ${currentVersion}`
    );
    this.name = 'KnowledgeDocumentVersionMismatchError';
  }
}

export function isKnowledgeDocumentVersionMismatchError(
  error: unknown
): error is KnowledgeDocumentVersionMismatchError {
  return error instanceof KnowledgeDocumentVersionMismatchError;
}

/** Clear explanation for the document-level gate layered over namespace write access. */
export class KnowledgeDocumentOwnerOnlyEditError extends Forbidden {
  constructor() {
    super(
      'This knowledge document uses owner-only editing. Only the document owner or an admin can update it.'
    );
    this.name = 'KnowledgeDocumentOwnerOnlyEditError';
  }
}
