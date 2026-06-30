import { useCallback, useEffect, useRef, useState } from 'react';

const MARK_CLASS = 'agor-search-highlight';

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clearMarks(container: HTMLElement) {
  container.querySelectorAll(`.${MARK_CLASS}`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    parent.normalize();
  });
}

function buildMarks(container: HTMLElement, query: string, highlightColor: string): HTMLElement[] {
  clearMarks(container);
  if (!query.trim()) return [];

  const regex = new RegExp(escapeRegex(query), 'gi');
  const marks: HTMLElement[] = [];

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || el.classList.contains(MARK_CLASS)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  let next = walker.nextNode();
  while (next) {
    textNodes.push(next as Text);
    next = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    if (!regex.test(text)) {
      regex.lastIndex = 0;
      continue;
    }
    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m = regex.exec(text);
    while (m !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = MARK_CLASS;
      mark.textContent = m[0];
      mark.style.cssText = `background:${highlightColor};color:rgba(0,0,0,0.88);border-radius:3px;padding:0 1px;`;
      frag.appendChild(mark);
      marks.push(mark);
      last = regex.lastIndex;
      m = regex.exec(text);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  return marks;
}

function paintMark(
  mark: HTMLElement,
  current: boolean,
  colors: { highlight: string; current: string; currentText: string }
) {
  if (current) {
    mark.style.background = colors.current;
    mark.style.color = colors.currentText;
    mark.style.outline = `2px solid ${colors.current}`;
    mark.style.outlineOffset = '1px';
  } else {
    mark.style.background = colors.highlight;
    mark.style.color = 'rgba(0,0,0,0.88)';
    mark.style.outline = 'none';
  }
}

export function useSessionSearch(
  containerRef: React.RefObject<HTMLElement | null>,
  colors?: { highlight: string; current: string; currentText: string }
) {
  const resolvedColors = colors ?? {
    highlight: 'rgba(250,173,20,0.4)',
    current: '#faad14',
    currentText: 'rgba(0,0,0,0.88)',
  };

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [totalMatches, setTotalMatches] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const marksRef = useRef<HTMLElement[]>([]);
  const hiddenBlocksRef = useRef<HTMLElement[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedColorsRef = useRef(resolvedColors);
  resolvedColorsRef.current = resolvedColors;

  const setCurrent = useCallback((idx: number, marks: HTMLElement[]) => {
    marks.forEach((m, i) => {
      paintMark(m, i === idx, resolvedColorsRef.current);
    });
    marks[idx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setCurrentMatch(idx);
  }, []);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setQuery('');
    setTotalMatches(0);
    setCurrentMatch(0);
  }, []);

  const closeSearch = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (containerRef.current) clearMarks(containerRef.current);
    marksRef.current = [];
    hiddenBlocksRef.current.forEach((el) => {
      el.style.display = '';
    });
    hiddenBlocksRef.current = [];
    setSearchOpen(false);
    setQuery('');
    setTotalMatches(0);
    setCurrentMatch(0);
  }, [containerRef]);

  useEffect(() => {
    if (!searchOpen) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!containerRef.current) return;

      // Restore any previously hidden blocks before re-running
      hiddenBlocksRef.current.forEach((el) => {
        el.style.display = '';
      });
      hiddenBlocksRef.current = [];

      const marks = buildMarks(containerRef.current, query, resolvedColorsRef.current.highlight);
      marksRef.current = marks;
      setTotalMatches(marks.length);
      setCurrentMatch(0);

      if (marks.length > 0) {
        setCurrent(0, marks);
        // Hide task blocks with no matches
        const allBlocks = Array.from(
          containerRef.current.querySelectorAll<HTMLElement>('[data-task-block]')
        );
        const matchedBlocks = new Set(
          marks.map((m) => m.closest('[data-task-block]')).filter(Boolean)
        );
        hiddenBlocksRef.current = allBlocks.filter((b) => !matchedBlocks.has(b));
        hiddenBlocksRef.current.forEach((el) => {
          el.style.display = 'none';
        });
      }
    }, 160);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, searchOpen, containerRef, setCurrent]);

  const goNext = useCallback(() => {
    const marks = marksRef.current;
    if (!marks.length) return;
    const next = (currentMatch + 1) % marks.length;
    setCurrent(next, marks);
  }, [currentMatch, setCurrent]);

  const goPrev = useCallback(() => {
    const marks = marksRef.current;
    if (!marks.length) return;
    const prev = (currentMatch - 1 + marks.length) % marks.length;
    setCurrent(prev, marks);
  }, [currentMatch, setCurrent]);

  return {
    searchOpen,
    query,
    setQuery,
    totalMatches,
    currentMatch,
    openSearch,
    closeSearch,
    goNext,
    goPrev,
  };
}
