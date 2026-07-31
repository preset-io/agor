import type { ThreadedComment } from './comment';
import type { KnowledgeDocumentID } from './knowledge';

/**
 * Comment on a Knowledge document, optionally anchored to one heading section.
 *
 * Gated by the document's namespace ACL rather than board membership: KB routes
 * are not board-scoped and most namespaces have no board at all.
 *
 * Anchoring uses the rendered heading slug (the same `#slug` KB deep links and
 * heading self-links already use) instead of `KnowledgeDocumentUnit.unit_id`.
 * Unit ids hash the version id, so they change on every edit, and units are
 * re-chunked wholesale when an admin changes the semantic chunking settings.
 */
export interface KnowledgeDocumentComment extends ThreadedComment {
  /** Document this comment belongs to */
  document_id: KnowledgeDocumentID;

  /** Heading slug this thread is anchored to; null for document-level threads */
  anchor_slug: string | null;

  /** Heading text captured at comment time, shown when the anchor is gone */
  anchor_label: string | null;

  // Text-range anchoring extends here, plus a rung in resolveKnowledgeCommentAnchor.
}

/**
 * Create input for a new Knowledge document comment.
 * `content_preview` is materialized from `content` by the repository.
 */
export type KnowledgeDocumentCommentCreate = Omit<
  KnowledgeDocumentComment,
  'comment_id' | 'created_at' | 'updated_at' | 'content_preview' | 'resolved' | 'edited'
> &
  Partial<Pick<KnowledgeDocumentComment, 'resolved'>>;

/** Patch input for updating a Knowledge document comment. */
export type KnowledgeDocumentCommentPatch = Partial<
  Pick<KnowledgeDocumentComment, 'content' | 'resolved'>
>;

/** A heading currently rendered in a document body. */
export interface KnowledgeDocumentHeading {
  /** Deterministic slug id assigned to the rendered heading element */
  slug: string;
  text: string;
  level: number;
}

export type KnowledgeCommentAnchorState =
  /** Thread applies to the whole document */
  | 'document'
  /** Thread's heading section is present in the current content */
  | 'anchored'
  /** Thread was anchored to a section that no longer exists */
  | 'orphaned';

export interface ResolvedKnowledgeCommentAnchor {
  state: KnowledgeCommentAnchorState;
  /** Heading slug the thread currently points at, if any */
  slug: string | null;
  /** Best available human label for the anchor */
  label: string | null;
}

export const KNOWLEDGE_COMMENT_DOCUMENT_ANCHOR_LABEL = 'Whole page';
export const KNOWLEDGE_COMMENT_ORPHANED_ANCHOR_LABEL = 'Removed sections';

/**
 * Resolve a stored anchor against the headings currently rendered.
 *
 * Fallback ladder, so an edit never drops a thread:
 * 1. exact slug match — the common case, survives edits inside the section
 * 2. heading-text match — survives a heading being moved or re-slugged
 * 3. orphaned — section is gone; the thread degrades to document level and
 *    keeps its stored label so the original context stays readable
 */
export function resolveKnowledgeCommentAnchor(
  comment: Pick<KnowledgeDocumentComment, 'anchor_slug' | 'anchor_label'>,
  headings: readonly KnowledgeDocumentHeading[]
): ResolvedKnowledgeCommentAnchor {
  if (!comment.anchor_slug) {
    return { state: 'document', slug: null, label: null };
  }

  const bySlug = headings.find((heading) => heading.slug === comment.anchor_slug);
  if (bySlug) {
    return { state: 'anchored', slug: bySlug.slug, label: bySlug.text };
  }

  const label = comment.anchor_label?.trim();
  if (label) {
    const byLabel = headings.find((heading) => heading.text.trim() === label);
    if (byLabel) {
      return { state: 'anchored', slug: byLabel.slug, label: byLabel.text };
    }
  }

  return { state: 'orphaned', slug: comment.anchor_slug, label: comment.anchor_label };
}
