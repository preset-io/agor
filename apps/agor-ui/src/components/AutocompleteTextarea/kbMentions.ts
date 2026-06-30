/**
 * Helpers for `@` autocomplete of Knowledge Base document references.
 *
 * Kept as pure functions (no React) so the matching/insertion logic can be
 * unit-tested without rendering the textarea.
 */

import {
  buildKnowledgeDocumentUri,
  KNOWLEDGE_DOCUMENT_URI_PREFIX,
  type KnowledgeDocument,
  type KnowledgeDocumentID,
} from '@agor/core/types';
import { buildKnowledgeRoutePath, namespaceSlugFromUri } from '@/utils/knowledgeRoutes';

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

// Non-throwing leaf title used only as a fallback when a doc has no title.
export const leafTitleFromPath = (path: string): string => {
  const leaf = path.split('/').filter(Boolean).pop() ?? path;
  return (
    leaf
      .replace(/\.(md|markdown)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim() || path
  );
};

/** Convert a readable Knowledge document row into the mention view model. */
export function kbMentionFromDocument(
  doc: Pick<KnowledgeDocument, 'document_id' | 'path' | 'uri' | 'title'>,
  routeBasePath = '/kb'
): KbDocMention | null {
  const path = doc.path?.trim();
  if (!path) return null;
  const slug = namespaceSlugFromUri(doc.uri);
  if (!slug) return null;
  return {
    title: doc.title?.trim() || leafTitleFromPath(path),
    documentId: doc.document_id,
    path,
    uri: doc.uri,
    routePath: buildKnowledgeRoutePath(routeBasePath, slug, path),
  };
}

export const uniqueKbMentions = (docs: KbDocMention[]): KbDocMention[] => {
  const seen = new Set<string>();
  const unique: KbDocMention[] = [];
  for (const doc of docs) {
    if (seen.has(doc.documentId)) continue;
    seen.add(doc.documentId);
    unique.push(doc);
  }
  return unique;
};

/**
 * Filter and rank a caller-provided KB doc set for the typed query. Matches
 * against title and path, preferring title prefix matches. With an empty query,
 * returns the first `limit` docs from that bounded local set.
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
 * Build a markdown link with a KB document title as the label. Escapes square
 * brackets so the title can't break out of link syntax.
 */
export function buildKbMarkdownLink(title: string, href: string): string {
  const label = title.replace(/[[\]]/g, '\\$&').trim() || 'Untitled';
  return `[${label}](${href})`;
}

/** Build the internal rename-proof KB document URI form for persisted Knowledge docs. */
export function buildKbDocLink(title: string, documentId: KnowledgeDocumentID): string {
  return buildKbMarkdownLink(title, buildKnowledgeDocumentUri(documentId));
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
