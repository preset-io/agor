'use client';

import { CornerDownLeft, FileText, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { trackEvent } from '../../lib/analytics';
import { getBasePath } from '../../lib/siteMetadata';
import styles from './IslandNav.module.css';
import { isExternal, NAV_MENUS, type NavIcon } from './navData';

export interface PaletteItem {
  section: string;
  label: string;
  desc?: string;
  icon: NavIcon;
  /** Navigate here, or run `action` instead. */
  href?: string;
  action?: () => void;
}

interface PagefindResult {
  url: string;
  meta: { title?: string };
  excerpt: string;
}

interface Pagefind {
  options: (opts: Record<string, unknown>) => Promise<void>;
  debouncedSearch: (
    q: string
  ) => Promise<{ results: Array<{ data: () => Promise<PagefindResult> }> } | null>;
}

let pagefind: Promise<Pagefind | null> | undefined;

// Same index the docs search uses; built by `pnpm build:search`. Missing in a
// fresh dev checkout, in which case the palette just skips docs results.
function loadPagefind(): Promise<Pagefind | null> {
  pagefind ??= import(/* webpackIgnore: true */ `${getBasePath()}/_pagefind/pagefind.js`)
    .then(async (mod: Pagefind) => {
      await mod.options({ baseUrl: '/' });
      return mod;
    })
    .catch(() => null);
  return pagefind;
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '');

const NAV_PALETTE_ITEMS: PaletteItem[] = NAV_MENUS.flatMap((menu) =>
  menu.groups.flatMap((group) =>
    group.items.map((item) => ({
      section: menu.label,
      label: item.label,
      desc: item.desc,
      icon: item.icon,
      href: item.href,
    }))
  )
);

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Extra rows (e.g. actions that need nav state, like "Book a demo"). */
  actions: PaletteItem[];
}

export function CommandPalette({ open, onClose, actions }: CommandPaletteProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [docResults, setDocResults] = useState<PaletteItem[]>([]);
  // Portal only after hydration: the server renders nothing here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    setDocResults([]);
    const focus = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(focus);
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setDocResults([]);
      return;
    }
    let cancelled = false;
    loadPagefind().then(async (pf) => {
      const search = await pf?.debouncedSearch(q);
      if (!search || cancelled) return;
      const top = await Promise.all(search.results.slice(0, 6).map((r) => r.data()));
      if (cancelled) return;
      setDocResults(
        top.map((r) => ({
          section: 'Docs & blog',
          label: r.meta.title ?? r.url,
          desc: stripTags(r.excerpt),
          icon: FileText,
          href: r.url.replace(/\.html$/, ''),
        }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [open, query]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = [...NAV_PALETTE_ITEMS, ...actions].filter(
      (item) => !q || `${item.label} ${item.desc ?? ''} ${item.section}`.toLowerCase().includes(q)
    );
    return [...matches, ...docResults];
  }, [query, actions, docResults]);

  const active = Math.min(selected, Math.max(0, items.length - 1));

  const run = (item: PaletteItem) => {
    onClose();
    trackEvent('nav_click', { target: item.href ?? item.label, placement: 'palette' });
    if (item.action) {
      item.action();
    } else if (item.href && isExternal(item.href)) {
      window.open(item.href, '_blank', 'noopener,noreferrer');
    } else if (item.href) {
      router.push(item.href);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected(Math.min(active + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(Math.max(active - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (items[active]) run(items[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  if (!mounted) return null;

  const groups: Array<{ title: string; rows: Array<{ item: PaletteItem; index: number }> }> = [];
  items.forEach((item, index) => {
    let group = groups[groups.length - 1];
    if (!group || group.title !== item.section) {
      group = { title: item.section, rows: [] };
      groups.push(group);
    }
    group.rows.push({ item, index });
  });

  return createPortal(
    <div
      className={open ? `${styles.paletteBackdrop} ${styles.paletteOpen}` : styles.paletteBackdrop}
      onMouseDown={onClose}
      aria-hidden={!open}
    >
      <div
        className={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-label="Search Agor"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={styles.paletteInputRow}>
          <Search size={20} aria-hidden className={styles.paletteSearchIcon} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search Agor, docs, and actions…"
            aria-label="Search Agor, docs, and actions"
            aria-activedescendant={items[active] ? `palette-row-${active}` : undefined}
            tabIndex={open ? 0 : -1}
          />
          <span className={styles.paletteKey}>esc</span>
        </div>
        <div className={styles.paletteResults} role="listbox">
          {groups.map((group) => (
            <div key={group.title} className={styles.paletteGroup}>
              <div className={styles.navGroupLabel}>{group.title}</div>
              {group.rows.map(({ item, index }) => (
                <div
                  key={`${item.section}-${item.label}-${item.href ?? ''}`}
                  id={`palette-row-${index}`}
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  className={
                    index === active
                      ? `${styles.paletteRow} ${styles.paletteRowActive}`
                      : styles.paletteRow
                  }
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => run(item)}
                  onKeyDown={() => {}}
                >
                  <span className={styles.paletteIcon}>
                    <item.icon size={17} aria-hidden />
                  </span>
                  <span className={styles.paletteText}>
                    <span className={styles.paletteLabel}>{item.label}</span>
                    {item.desc ? <span className={styles.paletteDesc}>{item.desc}</span> : null}
                  </span>
                  <CornerDownLeft size={15} aria-hidden className={styles.paletteReturn} />
                </div>
              ))}
            </div>
          ))}
          {items.length === 0 ? (
            <div className={styles.paletteEmpty}>No results for “{query}”</div>
          ) : null}
        </div>
        <div className={styles.paletteFooter}>
          <span>
            <span className={styles.paletteKey}>↑↓</span> navigate
          </span>
          <span>
            <span className={styles.paletteKey}>↵</span> open
          </span>
          <span className={styles.paletteFooterEnd}>
            <span className={styles.paletteKey}>⌘K</span> anywhere
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
