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

function buildMarks(container: HTMLElement, query: string): HTMLElement[] {
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
  let n: Text | null;
  while ((n = walker.nextNode() as Text | null)) textNodes.push(n);

  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    if (!regex.test(text)) { regex.lastIndex = 0; continue; }
    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = MARK_CLASS;
      mark.textContent = m[0];
      mark.style.cssText = 'background:rgba(252,211,77,0.35);color:inherit;border-radius:3px;padding:0 1px;';
      frag.appendChild(mark);
      marks.push(mark);
      last = regex.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  return marks;
}

function paintMark(mark: HTMLElement, current: boolean) {
  if (current) {
    mark.style.background = '#f97316';
    mark.style.color = '#fff';
    mark.style.outline = '2px solid #f97316';
    mark.style.outlineOffset = '1px';
  } else {
    mark.style.background = 'rgba(252,211,77,0.35)';
    mark.style.color = 'inherit';
    mark.style.outline = 'none';
  }
}

export function useSessionSearch(containerRef: React.RefObject<HTMLElement | null>) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [totalMatches, setTotalMatches] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const marksRef = useRef<HTMLElement[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setCurrent = useCallback((idx: number, marks: HTMLElement[]) => {
    marks.forEach((m, i) => paintMark(m, i === idx));
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
      const marks = buildMarks(containerRef.current, query);
      marksRef.current = marks;
      setTotalMatches(marks.length);
      setCurrentMatch(0);
      if (marks.length > 0) setCurrent(0, marks);
    }, 160);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
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

  return { searchOpen, query, setQuery, totalMatches, currentMatch, openSearch, closeSearch, goNext, goPrev };
}
