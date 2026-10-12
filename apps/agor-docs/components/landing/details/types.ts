import type { LandingPageId } from '../pages';

export type DetailMedia =
  | { type: 'image'; src: string; alt: string }
  | { type: 'video'; src: string; srcSmall?: string; poster: string; alt: string }
  /** A rendered component instead of a capture, e.g. the branch role matrix. */
  | { type: 'roleMatrix' };

/** One story block on a landing page. `id` is the anchor other pages deep-link to. */
export interface LandingDetail {
  id: string;
  /** Short label for the page's jump links. */
  navLabel: string;
  eyebrow?: string;
  /** Supports the heroCopy markup: {strong}, [accent], *italic*. */
  title: string;
  body: string[];
  points?: Array<{ title: string; body: string }>;
  media?: DetailMedia;
  links?: Array<{ label: string; href: string }>;
}

/**
 * Anchors the home page links to. Each page's detail list must include these
 * ids (it may add more).
 */
export const REQUIRED_ANCHORS: Record<LandingPageId, readonly string[]> = {
  multiplayer: ['live-presence', 'shared-environments', 'learn-together', 'enablers', 'any-agent'],
  board: ['presence', 'boards-and-zones', 'sessions', 'gateway'],
  teammates: [
    'memory',
    'skills-and-mcp',
    'onboarding',
    'channels',
    'schedules',
    'identity',
    'shared-ownership',
  ],
  'command-center': [
    'zones-and-prompts',
    'session-trees',
    'knowledge',
    'artifacts',
    'environments',
    'mcp',
  ],
  governance: ['visibility', 'permissions', 'isolation', 'model-choice', 'self-hosted', 'cloud'],
};

/** `/page#anchor` for a detail block; typed so a renamed anchor fails the build. */
export function detailHref(page: LandingPageId, anchor: string): string {
  const path = page === 'command-center' ? '/command-center' : `/${page}`;
  return `${path}#${anchor}`;
}
