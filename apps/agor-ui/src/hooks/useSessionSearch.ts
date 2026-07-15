import { theme } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { escapeRegExp } from '../components/HighlightMatch/HighlightMatch';

const HIGHLIGHT_NAME = 'agor-search';
const CURRENT_HIGHLIGHT_NAME = 'agor-search-current';
export const REBUILD_DEBOUNCE_MS = 160;

export interface SessionSearchColors {
  /** Base color for every match (rendered translucent). */
  highlight: string;
  /** Solid color for the active match. */
  current: string;
  /** Text color painted over the active match. */
  currentText: string;
}

// Structural view over the CSS Custom Highlight API so this compiles regardless
// of whether the installed TS DOM lib ships the (recent) `Highlight` types.
type CSSHighlight = { priority: number };
type CSSHighlightCtor = new (...ranges: Range[]) => CSSHighlight;
interface HighlightRegistryLike {
  set(name: string, highlight: CSSHighlight): void;
  delete(name: string): void;
}

function getHighlightApi(): { create: CSSHighlightCtor; registry: HighlightRegistryLike } | null {
  if (typeof window === 'undefined') return null;
  const global = window as unknown as {
    Highlight?: CSSHighlightCtor;
    CSS?: { highlights?: HighlightRegistryLike };
  };
  if (typeof global.Highlight !== 'function' || !global.CSS?.highlights) return null;
  return { create: global.Highlight, registry: global.CSS.highlights };
}

/**
 * Case-insensitive, non-overlapping match offsets of `query` within `text`.
 * Pure so the range-building logic stays unit-testable without a DOM.
 */
export function getMatchOffsets(text: string, query: string): Array<[number, number]> {
  if (!text || !query.trim()) return [];
  const regex = new RegExp(escapeRegExp(query), 'gi');
  const offsets: Array<[number, number]> = [];
  let match = regex.exec(text);
  while (match !== null) {
    offsets.push([match.index, match.index + match[0].length]);
    // Guard against a zero-length match wedging the loop.
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
    match = regex.exec(text);
  }
  return offsets;
}

function buildRanges(container: HTMLElement, query: string): Range[] {
  if (!query.trim()) return [];

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const ranges: Range[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? '';
    for (const [start, end] of getMatchOffsets(text, query)) {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      ranges.push(range);
    }
    node = walker.nextNode();
  }
  return ranges;
}

/**
 * Transcript boundaries that mark a *structural* change worth a re-scan:
 * a task mounting/unmounting, task hydration, or a new message/agent-chain
 * block appearing. Mutations inside an existing block (per-frame streaming
 * markdown growth) don't move these boundaries and are ignored — a full
 * TreeWalker re-scan per animation frame is exactly the cost this avoids.
 */
const STRUCTURAL_BLOCK_SELECTOR = '[data-task-block], [data-conversation-block]';
const BLOCK_MARKER_ATTRIBUTE = 'data-conversation-block';

export function isStructuralMutation(records: MutationRecord[]): boolean {
  for (const record of records) {
    // A message that finishes streaming settles *in place*: same wrapper node,
    // marker value flips 'streaming' → 'settled' (see TaskBlock). That's the
    // one boundary change with no childList signal, and it's exactly when the
    // fully-streamed text must become findable.
    if (record.type === 'attributes') {
      if (record.attributeName === BLOCK_MARKER_ATTRIBUTE) return true;
      continue;
    }
    if (record.type !== 'childList') continue;
    for (const nodes of [record.addedNodes, record.removedNodes]) {
      for (const node of nodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.matches(STRUCTURAL_BLOCK_SELECTOR) || el.querySelector(STRUCTURAL_BLOCK_SELECTOR)) {
          return true;
        }
      }
    }
  }
  return false;
}

function scrollRangeIntoView(range: Range) {
  const node = range.startContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/**
 * In-drawer find. Highlights matches with the CSS Custom Highlight API — text
 * nodes are read-only (ranges only), so React's tree is never mutated and
 * streaming/hydrating re-renders stay safe. Where the API is unavailable the
 * hook degrades to navigation without visible highlighting.
 */
export function useSessionSearch(
  containerRef: React.RefObject<HTMLElement | null>,
  colors?: SessionSearchColors
) {
  const { token } = theme.useToken();
  const resolvedColors = colors ?? {
    highlight: token.colorWarning,
    current: token.colorWarningBg,
    currentText: token.colorText,
  };

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [totalMatches, setTotalMatches] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [searchPending, setSearchPending] = useState(false);

  const apiRef = useRef<ReturnType<typeof getHighlightApi>>(null);
  const styleElRef = useRef<HTMLStyleElement | null>(null);
  const rangesRef = useRef<Range[]>([]);
  const currentIndexRef = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyHighlights = useCallback((ranges: Range[], currentIdx: number) => {
    const api = apiRef.current;
    if (!api) return;
    if (ranges.length === 0) {
      api.registry.delete(HIGHLIGHT_NAME);
      api.registry.delete(CURRENT_HIGHLIGHT_NAME);
      return;
    }
    api.registry.set(HIGHLIGHT_NAME, new api.create(...ranges));
    const current = ranges[currentIdx];
    if (current) {
      const highlight = new api.create(current);
      // Paint the active match on top of the base highlight.
      highlight.priority = 1;
      api.registry.set(CURRENT_HIGHLIGHT_NAME, highlight);
    } else {
      api.registry.delete(CURRENT_HIGHLIGHT_NAME);
    }
  }, []);

  const clearHighlights = useCallback(() => {
    const api = apiRef.current;
    if (api) {
      api.registry.delete(HIGHLIGHT_NAME);
      api.registry.delete(CURRENT_HIGHLIGHT_NAME);
    }
    rangesRef.current = [];
  }, []);

  const runSearch = useCallback(
    (scrollToCurrent: boolean) => {
      const container = containerRef.current;
      if (!container || !apiRef.current) {
        setTotalMatches(0);
        setSearchPending(false);
        return;
      }
      const ranges = buildRanges(container, queryRef.current);
      rangesRef.current = ranges;
      const idx = ranges.length === 0 ? 0 : Math.min(currentIndexRef.current, ranges.length - 1);
      currentIndexRef.current = idx;
      applyHighlights(ranges, idx);
      setTotalMatches(ranges.length);
      setCurrentMatch(idx);
      setSearchPending(false);
      if (scrollToCurrent && ranges[idx]) scrollRangeIntoView(ranges[idx]);
    },
    [containerRef, applyHighlights]
  );

  const setCurrent = useCallback(
    (idx: number) => {
      const ranges = rangesRef.current;
      if (!ranges.length) return;
      currentIndexRef.current = idx;
      applyHighlights(ranges, idx);
      setCurrentMatch(idx);
      if (ranges[idx]) scrollRangeIntoView(ranges[idx]);
    },
    [applyHighlights]
  );

  const openSearch = useCallback(() => {
    currentIndexRef.current = 0;
    setSearchOpen(true);
    setQuery('');
    setTotalMatches(0);
    setCurrentMatch(0);
  }, []);

  const closeSearch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearHighlights();
    currentIndexRef.current = 0;
    setSearchOpen(false);
    setQuery('');
    setTotalMatches(0);
    setCurrentMatch(0);
    setSearchPending(false);
  }, [clearHighlights]);

  // Detect the Custom Highlight API once and register the ::highlight() stylesheet.
  useEffect(() => {
    const api = getHighlightApi();
    apiRef.current = api;
    if (!api) return;
    const style = document.createElement('style');
    styleElRef.current = style;
    document.head.appendChild(style);
    return () => {
      style.remove();
      styleElRef.current = null;
      api.registry.delete(HIGHLIGHT_NAME);
      api.registry.delete(CURRENT_HIGHLIGHT_NAME);
    };
  }, []);

  // ::highlight() only accepts a handful of properties (no box-shadow/border),
  // so the active match is distinguished by a solid fill over the translucent base.
  useEffect(() => {
    const style = styleElRef.current;
    if (!style) return;
    style.textContent = `::highlight(${HIGHLIGHT_NAME}){background-color:color-mix(in srgb, ${resolvedColors.highlight} 40%, transparent);}::highlight(${CURRENT_HIGHLIGHT_NAME}){background-color:${resolvedColors.current};color:${resolvedColors.currentText};}`;
  }, [resolvedColors.highlight, resolvedColors.current, resolvedColors.currentText]);

  // Rebuild on query change and re-scan when the conversation mutates while open:
  // lazy task hydration, streaming updates, etc. all land after the initial scan.
  // `query` is a deliberate trigger — typing doesn't mutate the DOM, so the
  // observer never fires for it; runSearch reads the latest value via queryRef.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query re-runs the effect on typing; value is read via queryRef
  useEffect(() => {
    if (!searchOpen) return;
    const container = containerRef.current;
    if (!container || !apiRef.current) return;

    // A new query starts from the first match.
    currentIndexRef.current = 0;

    const scheduleRebuild = (scrollToCurrent: boolean) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setSearchPending(true);
      debounceRef.current = setTimeout(() => runSearch(scrollToCurrent), REBUILD_DEBOUNCE_MS);
    };

    scheduleRebuild(true);

    // Only block-level structural changes reschedule the scan. Character-level
    // mutations aren't observed and intra-block childList churn is filtered
    // out: while an agent streams, both fire once per frame, and each reset of
    // the debounce both starves the pending scan and queues a full-transcript
    // TreeWalker pass per quiet gap. Boundary changes that DO re-scan: a block
    // mounting/unmounting (childList) and a block's marker value flipping when
    // its message finishes streaming (attribute) — so late-streamed text is
    // findable at message completion, not at the next mount.
    const observer = new MutationObserver((records) => {
      if (isStructuralMutation(records)) scheduleRebuild(false);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [BLOCK_MARKER_ATTRIBUTE],
    });

    return () => {
      observer.disconnect();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, searchOpen, containerRef, runSearch]);

  const goNext = useCallback(() => {
    const total = rangesRef.current.length;
    if (!total) return;
    setCurrent((currentIndexRef.current + 1) % total);
  }, [setCurrent]);

  const goPrev = useCallback(() => {
    const total = rangesRef.current.length;
    if (!total) return;
    setCurrent((currentIndexRef.current - 1 + total) % total);
  }, [setCurrent]);

  return {
    searchOpen,
    query,
    setQuery,
    totalMatches,
    currentMatch,
    searchPending,
    openSearch,
    closeSearch,
    goNext,
    goPrev,
  };
}
