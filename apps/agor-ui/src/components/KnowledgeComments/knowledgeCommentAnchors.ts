import type { KnowledgeDocumentComment, KnowledgeDocumentHeading } from '@agor-live/client';
import { isThreadRoot, resolveKnowledgeCommentAnchor } from '@agor-live/client';
import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

/** A heading in the rendered document body, with its offset inside it. */
export interface MeasuredHeading extends KnowledgeDocumentHeading {
  /** Pixel offset of the heading from the top of the body container. */
  top: number;
}

const HEADING_SELECTOR = 'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]';

function measureHeadings(container: HTMLElement): MeasuredHeading[] {
  return [...container.querySelectorAll<HTMLElement>(HEADING_SELECTOR)].map((element) => ({
    slug: element.id,
    // The rendered heading carries a trailing '#' self-link that is not part of
    // the heading text.
    text: (element.textContent ?? '').replace(/#$/, '').trim(),
    level: Number(element.tagName.slice(1)),
    top: element.offsetTop,
  }));
}

/**
 * Tracks the headings rendered inside a markdown body.
 *
 * Reads the DOM rather than re-parsing the markdown so anchors always match the
 * ids `MarkdownRenderer` actually emitted — the same ids KB deep links use.
 */
export function useMeasuredHeadings(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  content: string
): MeasuredHeading[] {
  const [headings, setHeadings] = useState<MeasuredHeading[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `content` is not read here — it is the signal that the rendered headings changed.
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) {
      setHeadings([]);
      return;
    }

    const sync = () => {
      const next = measureHeadings(container);
      setHeadings((prev) =>
        prev.length === next.length &&
        prev.every(
          (heading, index) => heading.slug === next[index].slug && heading.top === next[index].top
        )
          ? prev
          : next
      );
    };

    sync();
    // Markdown rendering finishes asynchronously (syntax highlighting, Mermaid,
    // KaTeX), so offsets settle after the first paint.
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, enabled, content]);

  return headings;
}

export interface KnowledgeAnchorSummary {
  /** Unresolved thread roots per live heading slug. */
  unresolvedBySlug: Map<string, number>;
  /** Thread roots (resolved or not) per live heading slug. */
  totalBySlug: Map<string, number>;
  unresolvedTotal: number;
}

function increment(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Counts thread roots against the headings currently rendered, so the gutter
 * badges follow a thread when its section moves and drop it when it orphans.
 */
export function summarizeKnowledgeAnchors(
  comments: KnowledgeDocumentComment[],
  headings: readonly KnowledgeDocumentHeading[]
): KnowledgeAnchorSummary {
  const unresolvedBySlug = new Map<string, number>();
  const totalBySlug = new Map<string, number>();
  let unresolvedTotal = 0;

  for (const comment of comments) {
    if (!isThreadRoot(comment)) continue;
    if (!comment.resolved) unresolvedTotal += 1;

    const anchor = resolveKnowledgeCommentAnchor(comment, headings);
    if (anchor.state !== 'anchored' || !anchor.slug) continue;

    increment(totalBySlug, anchor.slug);
    if (!comment.resolved) increment(unresolvedBySlug, anchor.slug);
  }

  return { unresolvedBySlug, totalBySlug, unresolvedTotal };
}
