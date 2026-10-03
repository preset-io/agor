'use client';

import { BookOpen, CalendarDays, ChevronDown, Cloud, Menu, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { setMenu, useMenu } from 'nextra-theme-docs';
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { trackEvent } from '../../lib/analytics';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../../lib/links';
import { getBasePath, LOGO_MARK_PATH } from '../../lib/siteMetadata';
import { DiscordIcon, GitHubIcon } from '../BrandIcons';
import { CloudCtaLink } from '../CloudCtaLink';
import { HubSpotMeetingModal } from '../HubSpotMeetingModal';
import { LANDING_PAGES } from '../landing/pages';
import { CommandPalette, type PaletteItem } from './CommandPalette';
import styles from './IslandNav.module.css';
import { isExternal, NAV_LINKS, NAV_MENUS, type NavItem, type NavMenu } from './navData';

const HOVER_INTENT_MS = 120;
const CLOSE_DELAY_MS = 240;
const SCROLL_THRESHOLD = 40;
const NARROW_QUERY = '(max-width: 899px)';

type MenuId = NavMenu['id'];

// Full-bleed marketing pages sit under a transparent bar at the top; docs and
// blog pages always get the island surface (see IslandNav.module.css).
const MARKETING_PATHS = new Set(['/', '/cloud', '/contact', ...LANDING_PAGES.map((p) => p.href)]);

function trackNav(item: Pick<NavItem, 'href' | 'landing'>, placement: string) {
  trackEvent('nav_click', { target: item.href, placement });
  if (item.landing) {
    trackEvent('landing_page_click', { landing_page: item.landing, landing_anchor: '', placement });
  }
}

function NavItemLink({
  item,
  placement,
  onNavigate,
}: {
  item: NavItem;
  placement: string;
  onNavigate: () => void;
}) {
  const external = isExternal(item.href);
  return (
    <Link
      href={item.href}
      className={styles.navItem}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      onClick={() => {
        trackNav(item, placement);
        onNavigate();
      }}
    >
      <span className={styles.navItemIcon}>
        <item.icon size={16} aria-hidden />
      </span>
      <span className={styles.navItemText}>
        <span className={styles.navItemLabel}>{item.label}</span>
        <span className={styles.navItemDesc}>{item.desc}</span>
      </span>
    </Link>
  );
}

export function IslandNav() {
  const pathname = usePathname();
  const basePath = getBasePath();
  const [scrolled, setScrolled] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [expanded, setExpanded] = useState<MenuId | null>('product');
  const [demoOpen, setDemoOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panelRefs = useRef<Partial<Record<MenuId, HTMLDivElement | null>>>({});
  const triggerRefs = useRef<Partial<Record<MenuId, HTMLButtonElement | null>>>({});
  const isMarketing = MARKETING_PATHS.has(pathname ?? '');
  // Nextra's own docs sidebar (opened from "Browse this section"); the menu
  // button closes it too.
  const docsMenuOpen = useMenu();
  const anyMenuOpen = sheetOpen || docsMenuOpen;

  const clearTimers = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);

  const closeAll = useCallback(() => {
    clearTimers();
    setOpenMenu(null);
    setSheetOpen(false);
  }, [clearTimers]);

  // Scroll threshold: condense into the pill, and close any open menu on crossing.
  useEffect(() => {
    const onScroll = () => {
      const next = window.scrollY > SCROLL_THRESHOLD;
      setScrolled((prev) => {
        if (prev !== next) setOpenMenu(null);
        return next;
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close on every route change
  useEffect(() => {
    closeAll();
    setPaletteOpen(false);
  }, [pathname, closeAll]);

  // ⌘K / Ctrl+K toggles the palette; Esc closes everything.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        closeAll();
        setPaletteOpen((open) => !open);
      } else if (event.key === 'Escape') {
        if (openMenu) triggerRefs.current[openMenu]?.focus();
        closeAll();
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeAll, openMenu]);

  // The island's height tracks the active panel's rendered height.
  useEffect(() => {
    const panel = openMenu ? panelRefs.current[openMenu] : null;
    if (!panel) return;
    const measure = () => setPanelHeight(panel.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [openMenu]);

  useEffect(() => {
    document.body.style.overflow = sheetOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [sheetOpen]);

  useEffect(() => clearTimers, [clearTimers]);

  const enterTrigger = (id: MenuId) => {
    clearTimers();
    openTimer.current = setTimeout(() => setOpenMenu(id), openMenu ? 0 : HOVER_INTENT_MS);
  };

  const leaveIsland = () => {
    clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpenMenu(null), CLOSE_DELAY_MS);
  };

  const closeMenu = () => {
    clearTimers();
    setOpenMenu(null);
  };

  const focusFirstItem = (id: MenuId) => {
    requestAnimationFrame(() => {
      panelRefs.current[id]?.querySelector<HTMLAnchorElement>('a')?.focus();
    });
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: MenuId) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      clearTimers();
      setOpenMenu(id);
      focusFirstItem(id);
    }
  };

  // Arrow keys move between items inside the open panel; Tab out closes it.
  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!openMenu) return;
    const links = Array.from(
      panelRefs.current[openMenu]?.querySelectorAll<HTMLAnchorElement>('a') ?? []
    );
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      links[(index + delta + links.length) % links.length]?.focus();
    }
  };

  const onIslandBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu();
  };

  const openPalette = () => {
    closeAll();
    setPaletteOpen(true);
  };

  const paletteActions = useMemo<PaletteItem[]>(
    () => [
      {
        section: 'Actions',
        label: 'Agor Cloud',
        desc: 'Fully managed Agor',
        icon: Cloud,
        href: '/cloud',
      },
      {
        section: 'Actions',
        label: 'Book a demo',
        desc: 'Grab time with the team',
        icon: CalendarDays,
        action: () => setDemoOpen(true),
      },
      {
        section: 'Actions',
        label: 'Star on GitHub',
        desc: 'Support the project',
        icon: GitHubIcon,
        href: GITHUB_REPO_URL,
      },
      {
        section: 'Actions',
        label: 'Join Discord',
        desc: 'Community chat',
        icon: DiscordIcon,
        href: DISCORD_INVITE_URL,
      },
    ],
    []
  );

  const activeIndex = NAV_MENUS.findIndex((menu) => menu.id === openMenu);
  const islandState = {
    'data-scrolled': scrolled ? 'true' : 'false',
    'data-open': openMenu && !narrow ? 'true' : 'false',
    'data-marketing': isMarketing ? 'true' : 'false',
  };

  return (
    <>
      <div className={styles.spacer} aria-hidden="true" />
      <header
        className={styles.island}
        {...islandState}
        style={{ '--panel-h': `${panelHeight}px` } as CSSProperties}
        // Menus close when the pointer leaves the whole island (or on click,
        // Esc, or navigation), not when it crosses Docs/Blog/the logo: the
        // pill widens on open and the row slides under a still cursor.
        onMouseLeave={narrow ? undefined : leaveIsland}
        onMouseEnter={() => clearTimeout(closeTimer.current)}
        onBlur={onIslandBlur}
      >
        <div className={styles.bar}>
          <div className={styles.barLeft}>
            <Link href="/" className={styles.logo} aria-label="Agor home">
              {/* biome-ignore lint/performance/noImgElement: Static logo asset */}
              <img src={`${basePath}${LOGO_MARK_PATH}`} alt="" width="30" height="30" />
              <span className="agor-docs-wordmark">agor</span>
            </Link>
            <nav className={styles.triggers} aria-label="Main">
              {NAV_MENUS.map((menu) => {
                const open = openMenu === menu.id;
                return (
                  <button
                    key={menu.id}
                    ref={(el) => {
                      triggerRefs.current[menu.id] = el;
                    }}
                    type="button"
                    className={open ? `${styles.trigger} ${styles.triggerOpen}` : styles.trigger}
                    aria-expanded={open}
                    aria-controls={`island-panel-${menu.id}`}
                    onMouseEnter={() => enterTrigger(menu.id)}
                    onClick={() => {
                      clearTimers();
                      setOpenMenu(open ? null : menu.id);
                    }}
                    onKeyDown={(event) => onTriggerKeyDown(event, menu.id)}
                  >
                    {menu.label}
                    <ChevronDown size={13} aria-hidden className={styles.caret} />
                  </button>
                );
              })}
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={styles.trigger}
                  onClick={() => trackNav(link, 'navbar')}
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className={styles.barRight}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Search (⌘K)"
              onClick={openPalette}
            >
              <Search size={17} aria-hidden />
            </button>
            <span className={styles.ctaSlot}>
              <CloudCtaLink placement="navbar" compact className={styles.cta} />
            </span>
            <button
              type="button"
              className={`${styles.iconButton} ${styles.menuButton}`}
              aria-label={anyMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={anyMenuOpen}
              aria-controls="island-sheet"
              onClick={() => {
                if (docsMenuOpen) {
                  setMenu(false);
                } else {
                  setSheetOpen((open) => !open);
                }
              }}
            >
              {anyMenuOpen ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
            </button>
          </div>
        </div>

        <div className={styles.menuRegion} onKeyDown={onPanelKeyDown}>
          {NAV_MENUS.map((menu, index) => {
            const on = menu.id === openMenu;
            const offset = on || activeIndex < 0 ? 0 : index < activeIndex ? -28 : 28;
            return (
              <div
                key={menu.id}
                id={`island-panel-${menu.id}`}
                ref={(el) => {
                  panelRefs.current[menu.id] = el;
                }}
                className={on ? `${styles.panel} ${styles.panelOn}` : styles.panel}
                style={{ '--panel-x': `${offset}px` } as CSSProperties}
                aria-hidden={!on}
                inert={!on}
              >
                <div
                  className={styles.panelGrid}
                  style={{ '--cols': menu.groups.length } as CSSProperties}
                >
                  {menu.groups.map((group) => (
                    <div key={group.title} className={styles.panelGroup}>
                      <div className={styles.navGroupLabel}>{group.title}</div>
                      {group.items.map((item) => (
                        <NavItemLink
                          key={item.href}
                          item={item}
                          placement="navbar-menu"
                          onNavigate={closeMenu}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                {menu.feature ? (
                  <Link
                    href={menu.feature.href}
                    className={styles.feature}
                    {...(isExternal(menu.feature.href)
                      ? { target: '_blank', rel: 'noopener noreferrer' }
                      : {})}
                    onClick={() => {
                      trackNav({ href: menu.feature?.href ?? '' }, 'navbar-feature');
                      closeMenu();
                    }}
                  >
                    <span className={styles.featureKicker}>{menu.feature.kicker}</span>
                    <span className={styles.featureTitle}>{menu.feature.title}</span>
                    <span className={styles.featureCta}>
                      {menu.feature.cta} <span aria-hidden="true">→</span>
                    </span>
                  </Link>
                ) : null}
              </div>
            );
          })}
        </div>
      </header>

      <div
        id="island-sheet"
        className={sheetOpen ? `${styles.sheet} ${styles.sheetOpen}` : styles.sheet}
        aria-hidden={!sheetOpen}
        inert={!sheetOpen}
      >
        <div className={styles.sheetScroll}>
          {!isMarketing ? (
            <button
              type="button"
              className={styles.sheetRow}
              onClick={() => {
                setSheetOpen(false);
                setMenu(true);
              }}
            >
              <span className={styles.sheetRowLead}>
                <BookOpen size={18} aria-hidden /> Browse this section
              </span>
              <span aria-hidden="true">→</span>
            </button>
          ) : null}
          {NAV_MENUS.map((menu) => {
            const open = expanded === menu.id;
            return (
              <div key={menu.id} className={styles.sheetSection}>
                <button
                  type="button"
                  className={styles.sheetRow}
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : menu.id)}
                >
                  {menu.label}
                  <ChevronDown
                    size={16}
                    aria-hidden
                    className={open ? `${styles.caret} ${styles.caretOpen}` : styles.caret}
                  />
                </button>
                {open ? (
                  <div className={styles.sheetGroups}>
                    {menu.groups.map((group) => (
                      <div key={group.title}>
                        <div className={styles.navGroupLabel}>{group.title}</div>
                        {group.items.map((item) => (
                          <NavItemLink
                            key={item.href}
                            item={item}
                            placement="mobile-nav"
                            onNavigate={() => setSheetOpen(false)}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={styles.sheetRow}
              onClick={() => {
                trackNav(link, 'mobile-nav');
                setSheetOpen(false);
              }}
            >
              {link.label}
            </Link>
          ))}
        </div>
        <div className={styles.sheetFooter}>
          <div className={styles.sheetFooterPair}>
            <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
              <GitHubIcon size={17} aria-hidden /> Star
            </a>
            <a href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">
              <DiscordIcon size={17} aria-hidden /> Discord
            </a>
          </div>
          <CloudCtaLink placement="mobile-nav" className={styles.sheetCta} />
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />
      {demoOpen &&
        createPortal(
          <HubSpotMeetingModal isOpen onClose={() => setDemoOpen(false)} />,
          document.body
        )}
    </>
  );
}
