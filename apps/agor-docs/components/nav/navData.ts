import {
  BookOpen,
  Bot,
  Braces,
  Cloud,
  Command,
  HelpCircle,
  LayoutDashboard,
  type LucideIcon,
  MessagesSquare,
  Newspaper,
  Rocket,
  Shield,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL, LINKEDIN_URL, X_URL } from '../../lib/links';
import { DiscordIcon, GitHubIcon, LinkedInIcon, XIcon } from '../BrandIcons';
import { type LandingPageId, landingPage } from '../landing/pages';

/** A Lucide icon or one of the brand marks in components/BrandIcons. */
export type NavIcon = ComponentType<{ size?: number | string; 'aria-hidden'?: boolean | 'true' }>;

export interface NavItem {
  label: string;
  desc: string;
  href: string;
  icon: NavIcon;
  /** Set for landing pages, so clicks also count toward landing_page_click. */
  landing?: LandingPageId;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export interface NavMenu {
  id: 'product' | 'resources';
  label: string;
  groups: NavGroup[];
  feature?: { kicker: string; title: string; cta: string; href: string };
}

const landingItem = (id: LandingPageId, icon: LucideIcon): NavItem => {
  const page = landingPage(id);
  return { label: page.navLabel, desc: page.tagline, href: page.href, icon, landing: id };
};

// The one IA source for the island menus, the mobile sheet, and the command
// palette. Growth rule from the design handoff: new pages join an existing
// group (or a new group, 4 max per menu) and always appear in the palette;
// revisit the IA before adding a fifth top-level item.
export const NAV_MENUS: NavMenu[] = [
  {
    id: 'product',
    label: 'Product',
    groups: [
      {
        title: 'Collaborate',
        items: [
          landingItem('multiplayer', Users),
          landingItem('board', LayoutDashboard),
          landingItem('teammates', Bot),
        ],
      },
      {
        title: 'Operate',
        items: [
          landingItem('command-center', Command),
          {
            label: 'Agor Cloud',
            desc: 'Fully managed Agor for your whole team.',
            href: '/cloud',
            icon: Cloud,
          },
        ],
      },
      {
        title: 'Trust',
        items: [
          landingItem('governance', ShieldCheck),
          {
            label: 'Security',
            desc: 'Controls, trust boundaries, and the roadmap.',
            href: '/security',
            icon: Shield,
          },
        ],
      },
    ],
    feature: {
      kicker: 'Agor Cloud',
      title: 'Fully managed Agor for your whole team',
      cta: 'See Agor Cloud',
      href: '/cloud',
    },
  },
  {
    id: 'resources',
    label: 'Resources',
    groups: [
      {
        title: 'Learn',
        items: [
          {
            label: 'Docs',
            desc: 'Guides, concepts, and reference.',
            href: '/guide',
            icon: BookOpen,
          },
          {
            label: 'Getting started',
            desc: 'Install Community Edition and raise your first teammate.',
            href: '/guide/getting-started',
            icon: Rocket,
          },
          {
            label: 'API reference',
            desc: 'The daemon’s REST API.',
            href: '/api-reference',
            icon: Braces,
          },
          { label: 'FAQ', desc: 'Common questions, answered.', href: '/faq', icon: HelpCircle },
        ],
      },
      {
        title: 'Stay current',
        items: [
          {
            label: 'Blog',
            desc: 'Product news and engineering notes.',
            href: '/blog',
            icon: Newspaper,
          },
          {
            label: 'Talk to us',
            desc: 'Book time with the team.',
            href: '/contact',
            icon: MessagesSquare,
          },
        ],
      },
      {
        title: 'Community',
        items: [
          {
            label: 'GitHub',
            desc: 'Star, fork, and contribute.',
            href: GITHUB_REPO_URL,
            icon: GitHubIcon,
          },
          {
            label: 'Discord',
            desc: 'Ask questions, share workflows.',
            href: DISCORD_INVITE_URL,
            icon: DiscordIcon,
          },
          {
            label: 'X',
            desc: 'Follow @agorcloud for updates.',
            href: X_URL,
            icon: XIcon,
          },
          {
            label: 'LinkedIn',
            desc: 'News from the Agor team.',
            href: LINKEDIN_URL,
            icon: LinkedInIcon,
          },
        ],
      },
      {
        title: 'Stories',
        items: [
          {
            label: 'Agent roster',
            desc: 'The AI teammates Preset runs on Agor.',
            href: '/agent-roster',
            icon: Bot,
          },
          {
            label: 'Meet Wendy',
            desc: 'Our competitive intelligence agent.',
            href: '/blog/meet-wendy-preset-ai-competitive-intelligence-analyst',
            icon: Bot,
          },
          {
            label: 'Meet Blake',
            desc: 'Our deal desk agent.',
            href: '/blog/meet-blake',
            icon: Bot,
          },
          {
            label: 'Meet Hodor',
            desc: 'Agor’s own product manager.',
            href: '/blog/meet-hodor',
            icon: Bot,
          },
          {
            label: 'Meet Bug Basher',
            desc: 'Hunts Apache Superset bugs.',
            href: '/blog/meet-bug-basher',
            icon: Bot,
          },
        ],
      },
    ],
  },
];

/** Direct top-level links beside the two menus. */
export const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: 'Docs', href: '/guide' },
  { label: 'Blog', href: '/blog' },
];

export const isExternal = (href: string) => /^https?:\/\//.test(href);
