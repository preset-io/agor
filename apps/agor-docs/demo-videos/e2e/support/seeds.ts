// Named starting states for clips, built off camera by the seeder and
// cached as checkpoints ("migrations as cache").
//
// A seed extends at most one other seed, so states stack: `team-board`
// is `workspace` plus a board. Building a seed restores the deepest cached
// ancestor and runs only what's missing. The cache key is a hash of each
// seed's own code (and the seeding library's), so editing a seed rebuilds
// it and everything stacked on it, and nothing else.
//
//   npm run seed -- team-board            # build (or reuse) a seed
//   npm run seed -- team-board --rebuild  # rebuild it from its parent
//   npm run seed -- --list
//
// Seeds that run real agent turns (Seeder.prompt) declare agent: true. Their
// turns are recorded once into cassettes/seed-<name>.json and replayed on
// every rebuild after that (pass --live to record them again).

import { CAST_KEYS } from './cast.ts';
import { DEMO_REPO_PATH } from './harness.ts';
import type { Seeder } from './seeder.ts';
import { donutOps } from './seeds/donut-ops.ts';
import { saasy } from './seeds/saasy.ts';

export interface SeedDef {
  name: string;
  extends?: string;
  description: string;
  /** Runs real agent turns (needs the cassette proxy). */
  agent?: boolean;
  /**
   * Files or directories (relative to the e2e folder) the seed reads besides
   * its own code: persona modules, fixture repos, datasets. Hashed into the
   * cache key, so editing any of them rebuilds the seed.
   */
  inputs?: string[];
  run(s: Seeder): Promise<void>;
}

export const SEEDS: SeedDef[] = [
  {
    name: 'workspace',
    description:
      'The cast (Sam, Ada, Grace, Kai) signed up with onboarding done and Claude Code connected; the donut-shop repo registered.',
    async run(s) {
      await s.cast(CAST_KEYS);
      await s.connectAi(CAST_KEYS);
      await s.repo('donut-shop', DEMO_REPO_PATH, 'preset-io/donut-shop');
    },
  },
  {
    name: 'team-board',
    extends: 'workspace',
    description:
      'A shared "Donut Shop" team board: four workflow zones, five real branches across them, and a comment thread with replies.',
    async run(s) {
      // Canvas units. A branch card is ~500 wide and ~190 tall, so zones are
      // 560 wide with room for three cards stacked.
      const zone = (label: string, col: number, color: string) => ({
        label,
        x: col * 620,
        y: 0,
        width: 560,
        height: 760,
        color,
      });
      await s.board('main', {
        title: 'Donut Shop',
        icon: '🍩',
        description: 'Storefront, back office, and the daily specials.',
        zones: {
          backlog: zone('Up next', 0, '#8c8c8c'),
          building: zone('Building', 1, '#1677ff'),
          review: zone('In review', 2, '#fa8c16'),
          shipped: zone('Shipped', 3, '#52c41a'),
        },
      });
      const branch = (
        name: string,
        zone: string,
        row: number,
        as: 'sam' | 'ada' | 'grace' | 'kai'
      ) =>
        s.branch({
          name,
          repo: 'donut-shop',
          board: 'main',
          zone,
          at: { x: 30, y: 70 + row * 230 },
          as,
        });
      await branch('daily-specials-banner', 'backlog', 0, 'kai');
      await branch('glaze-menu-refresh', 'building', 0, 'sam');
      await branch('loyalty-punch-card', 'building', 1, 'ada');
      await branch('order-ahead-checkout', 'review', 0, 'grace');
      await branch('fix-register-rounding', 'shipped', 0, 'ada');
      // Pinned low in the review zone, clear of cards dropped into it.
      await s.comment('main', {
        as: 'grace',
        text: 'Checkout flow is ready for eyes. Can someone try it on a phone?',
        at: { x: 2 * 620 + 430, y: 640 },
        replies: [{ as: 'ada', text: 'On it after the punch card lands.' }],
        reactions: [{ as: 'sam', emoji: '🙌' }],
      });
    },
  },
  saasy,
  donutOps,
];

export function seedByName(name: string): SeedDef {
  const seed = SEEDS.find((s) => s.name === name);
  if (!seed)
    throw new Error(`Unknown seed "${name}". Known: ${SEEDS.map((s) => s.name).join(', ')}`);
  return seed;
}

/** The seed and its ancestors, root first. */
export function seedChain(name: string): SeedDef[] {
  const chain: SeedDef[] = [];
  for (
    let s: SeedDef | undefined = seedByName(name);
    s;
    s = s.extends ? seedByName(s.extends) : undefined
  ) {
    if (chain.includes(s)) throw new Error(`seed ${name} extends itself`);
    chain.unshift(s);
  }
  return chain;
}
