/**
 * Helpers for `@` autocomplete of Knowledge Base document references.
 *
 * Kept as pure functions (no React) so the matching/insertion logic can be
 * unit-tested without rendering the textarea.
 */

import {
  buildKnowledgeDocumentUri,
  KNOWLEDGE_DOCUMENT_URI_PREFIX,
  type KnowledgeDocumentID,
} from '@agor/core/types';

export interface KbDocMention {
  /** Display title, used as the dropdown label and the markdown link text. */
  title: string;
  /** Document UUID — the rename-proof identity used in the inserted link. */
  documentId: KnowledgeDocumentID;
  /** Normalized document path within its namespace (used for matching). */
  path: string;
  /** Canonical `agor://kb/<namespace>/<path>` URI for the doc. */
  uri: string;
  /** In-app route (e.g. `/kb/<namespace>/<path>`) used to hydrate links for display. */
  routePath: string;
}

export const MAX_KB_DOC_RESULTS = 8;

/**
 * Filter and rank KB docs for the typed query. Matches against title and path,
 * preferring title prefix matches. With an empty query, returns the first
 * `limit` docs so the dropdown is useful immediately after typing `@`.
 */
export function filterKbDocs(
  docs: KbDocMention[],
  query: string,
  limit: number = MAX_KB_DOC_RESULTS
): KbDocMention[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs.slice(0, limit);

  const rank = (doc: KbDocMention): number => {
    const title = doc.title.toLowerCase();
    const path = doc.path.toLowerCase();
    if (title === q) return 0;
    if (title.startsWith(q)) return 1;
    if (title.includes(q)) return 2;
    if (path.includes(q)) return 3;
    return 4;
  };

  return docs
    .map((doc) => ({ doc, score: rank(doc) }))
    .filter(({ score }) => score < 4)
    .sort((a, b) => a.score - b.score || a.doc.title.localeCompare(b.doc.title))
    .slice(0, limit)
    .map(({ doc }) => doc);
}

/**
 * Build a markdown link to a KB doc. The href is the rename-proof
 * `agor://kb/document/<uuid>` URI (hydrated to a clickable route at render time);
 * the label is the doc title with `[` / `]` escaped so it can't break out of the
 * link syntax.
 */
export function buildKbDocLink(title: string, documentId: KnowledgeDocumentID): string {
  const label = title.replace(/[[\]]/g, '\\$&').trim() || 'Untitled';
  return `[${label}](${buildKnowledgeDocumentUri(documentId)})`;
}

const KB_DOC_URI_RE = new RegExp(
  `${KNOWLEDGE_DOCUMENT_URI_PREFIX.replace(/[/]/g, '\\$&')}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`,
  'gi'
);

/**
 * Rewrite `agor://kb/document/<uuid>` references to clickable in-app routes for
 * display. Unknown ids (doc not loaded / deleted) are left untouched so the raw
 * URI degrades gracefully rather than producing a broken link.
 */
export function hydrateKbDocLinks(
  markdown: string,
  resolveRoute: (documentId: string) => string | null | undefined
): string {
  if (!markdown) return markdown;
  return markdown.replace(
    KB_DOC_URI_RE,
    (full, id: string) => resolveRoute(id.toLowerCase()) ?? full
  );
}
