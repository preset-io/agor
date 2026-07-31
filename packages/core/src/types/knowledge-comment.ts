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

/**
 * Deliberately three states. Every way an anchor can fail to resolve — section
 * deleted, label ambiguous, whatever a later rung adds — collapses into
 * `orphaned` so the UI has one visual language for "came unmoored" rather than
 * one per failure mode. Add a rung to the ladder, not a state here.
 */
export type KnowledgeCommentAnchorState =
  /** Thread applies to the whole document */
  | 'document'
  /** Thread's heading section is present in the current content */
  | 'anchored'
  /** Thread's section could not be identified in the current content */
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
 * A slug ending in `-<n>` was the nth same-titled heading in the document, so
 * its heading text was never enough to identify it on its own.
 */
const DEDUPED_SLUG = /-\d+$/;

/**
 * Resolve a stored anchor against the headings currently rendered.
 *
 * Fallback ladder, so an edit never drops a thread:
 * 1. exact slug match — the common case, survives edits inside the section
 * 2. heading-text match, but only when that text identifies exactly one
 *    section now AND identified exactly one when the thread was written.
 *    Otherwise orphan: showing a thread against a same-titled but unrelated
 *    section is worse than admitting it came unmoored.
 * 3. orphaned — section is gone; the thread degrades to document level and
 *    keeps its stored label so the original context stays readable
 *
 * Known limitation: slugs carry positional dedup suffixes, so deleting the
 * first of two same-titled headings renumbers the second onto the first's slug
 * and rung 1 matches it. Distinguishing those needs a stored heading ordinal or
 * section content hash.
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
  if (label && !DEDUPED_SLUG.test(comment.anchor_slug)) {
    const byLabel = headings.filter((heading) => heading.text.trim() === label);
    if (byLabel.length === 1) {
      return { state: 'anchored', slug: byLabel[0].slug, label: byLabel[0].text };
    }
  }

  return { state: 'orphaned', slug: comment.anchor_slug, label: comment.anchor_label };
}
