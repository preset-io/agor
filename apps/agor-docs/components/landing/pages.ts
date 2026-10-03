export type LandingPageId = 'multiplayer' | 'board' | 'teammates' | 'command-center' | 'governance';

export interface LandingPageEntry {
  id: LandingPageId;
  href: `/${string}`;
  /** Home-hero hub button and "learn more" link text. */
  navLabel: string;
  /** One-line promise, reused on cards that point at the page (e.g. /cloud). */
  tagline: string;
  docs: Array<{ label: string; href: string }>;
}

// Order follows the positioning hierarchy: Multiplayer AI, the board,
// teammates, then the builder and trust stories. It is also the order of the
// home hero's hub buttons.
export const LANDING_PAGES: LandingPageEntry[] = [
  {
    id: 'multiplayer',
    href: '/multiplayer',
    navLabel: 'Multiplayer AI',
    tagline: 'Bring your team and agents together.',
    docs: [
      { label: 'Multiplayer & social features', href: '/guide/multiplayer-social' },
      { label: 'Branches & shared environments', href: '/guide/branches' },
      { label: 'Supported agents', href: '/guide/sdk-comparison' },
    ],
  },
  {
    id: 'board',
    href: '/board',
    navLabel: 'Live board',
    tagline: 'See the work and shape it together.',
    docs: [
      { label: 'Boards & zones', href: '/guide/boards' },
      { label: 'Sessions & trees', href: '/guide/sessions' },
      { label: 'Message gateway', href: '/guide/message-gateway' },
    ],
  },
  {
    id: 'teammates',
    href: '/teammates',
    navLabel: 'AI teammates',
    tagline: 'Raise AI teammates your team can teach.',
    docs: [
      { label: 'Teammates', href: '/guide/teammates' },
      { label: 'Knowledge', href: '/guide/knowledge' },
      { label: 'Scheduler', href: '/guide/scheduler' },
      { label: 'Message gateway', href: '/guide/message-gateway' },
    ],
  },
  {
    id: 'command-center',
    href: '/command-center',
    navLabel: 'Command center',
    tagline: 'Stay sane with a lot of agents.',
    docs: [
      { label: 'Feature map', href: '/guide/features-overview' },
      { label: 'Artifacts', href: '/guide/artifacts' },
      { label: 'Environments', href: '/guide/environment-configuration' },
      { label: 'Agor MCP server', href: '/guide/internal-mcp' },
    ],
  },
  {
    id: 'governance',
    href: '/governance',
    navLabel: 'Governance',
    tagline: 'Know what’s running and who can do what.',
    docs: [
      { label: 'Security', href: '/security' },
      { label: 'RBAC & isolation', href: '/guide/multiplayer-unix-isolation' },
      { label: 'Agor Cloud', href: '/cloud' },
    ],
  },
];

export function landingPage(id: LandingPageId): LandingPageEntry {
  const page = LANDING_PAGES.find((entry) => entry.id === id);
  if (!page) throw new Error(`Unknown landing page: ${id}`);
  return page;
}
