// The EngTeam board after eng-build's two asks, and mid-flight: see
// eng-team.ts for the story. Kept apart from eng-team so changing these
// never rebuilds it (eng-build's recorded turns refer to its board by id).

import { Puppet } from '../puppet.ts';
import type { SeedDef } from '../seeds.ts';
import { WORKFLOW } from './eng-team.ts';
import { APP, SAASY_JIRA } from './saasy.ts';

const ISSUES = `https://github.com/${APP}/issues`;

/** The five tickets EngBot picked in the recorded eng-build turn, in the order it made them. */
export const PICKS = [
  { name: 'gh-331-case-insensitive-skills', issue: `${ISSUES}/331` },
  { name: 'gh-322-invoice-line-discounts', issue: `${ISSUES}/322` },
  { name: 'gh-327-offline-queue-drops', issue: `${ISSUES}/327` },
  { name: 'saasy-440-reject-inverted-window', issue: `${SAASY_JIRA}/SAASY-440` },
  { name: 'saasy-431-late-fee-due-date', issue: `${SAASY_JIRA}/SAASY-431` },
];

export const engBoard: SeedDef = {
  name: 'eng-board',
  extends: 'eng-team',
  description:
    'The EngTeam board as EngBot builds it: the workflow zones and five tickets in Backlog.',
  inputs: ['support/seeds/eng-flow.ts'],
  async run(s) {
    await s.zones('eng', WORKFLOW);
    for (const [i, pick] of PICKS.entries()) {
      await s.branch({
        name: pick.name,
        repo: 'saasy-app',
        board: 'eng',
        zone: 'backlog',
        at: { x: 30, y: 70 + i * 220 },
        from: 'main',
        issueUrl: pick.issue,
      });
    }
  },
};

/** The ticket the story follows from build to merge: the customer-reported late fee. */
export const HERO = 'saasy-431-late-fee-due-date';
export const HERO_PR = `https://github.com/${APP}/pull/339`;

const BUILD_TITLES: Record<string, string> = {
  'gh-331-case-insensitive-skills': 'Match technician skills case-insensitively',
  'gh-322-invoice-line-discounts': 'Apply per-line discounts to invoice totals',
  'gh-327-offline-queue-drops': 'Keep status updates when the offline queue is full',
  'saasy-440-reject-inverted-window': 'Reject job windows that end before they start',
  'saasy-431-late-fee-due-date': 'Count due-date payments as on time',
};

export const engFlow: SeedDef = {
  name: 'eng-flow',
  extends: 'eng-board',
  description:
    'EngTeam mid-flight: all five tickets in In Progress with Claude building each (the late-fee ticket first, the one the story follows).',
  inputs: ['support/seeds/eng-flow.ts', 'support/puppet.ts'],
  async run(s) {
    const puppet = new Puppet(await s.as('sam'), s.world, 'eng');
    const order = [HERO, ...PICKS.map((p) => p.name).filter((n) => n !== HERO)];
    for (const [i, name] of order.entries()) {
      await puppet.place(name, 'progress', i);
      await s.session(`build-${name}`, { branch: name, title: BUILD_TITLES[name] });
    }
  },
};
