// SaaSy Co.: a fictional B2B SaaS company (scheduling, dispatch and invoicing
// for field-service trades) and its AI teammates, for the "AI teammates can
// do anything" clips. Sam, Ada, Grace and Kai are its engineering team.
//
// - DataBot owns the analytics warehouse (fixtures/data/saasy) and the
//   dbt project (fixtures/repos/saasy-analytics), cloned into its branch.
// - EngBot reads the team's board (branches named for Jira tickets, with
//   ticket and PR links) and the PRs in the GitHub stand-in.
// - LegalBot reviews contracts against SaaSy Co.'s playbook.

import {
  buildSaasyWarehouse,
  cloneInto,
  type FakePull,
  fakeGithub,
  localRepo,
} from '../fixtures.ts';
import type { SeedDef } from '../seeds.ts';

export const SAASY_JIRA = 'https://saasy-co.atlassian.net/browse';
const APP = 'saasy-co/app';
const ANALYTICS = 'saasy-co/analytics';
const pr = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

const TEAM = `## The team

| Person | GitHub | Focus |
| --- | --- | --- |
| Sam Rivera | sam-saasyco | Engineering manager, billing |
| Ada Okafor | ada-saasyco | Scheduling and routing |
| Grace Liu | grace-saasyco | Integrations (QuickBooks), analytics |
| Kai Moreno | kai-saasyco | Mobile app, finance reporting |
`;

const USER = `- **Name:** Sam Rivera
- **What to call them:** Sam
- **Role:** Engineering manager at SaaSy Co.

## Sharing and action preferences

- **External actions:** pushing branches and opening pull requests in SaaSy Co.'s
  repos is pre-approved; everything else, ask first.
- **Style:** short answers, numbers over adjectives, tables when comparing.`;

const APP_PULLS: FakePull[] = [
  {
    number: 318,
    title: 'SAASY-412: Route optimizer respects customer time windows',
    head: 'saasy-412-route-time-windows',
    author: 'ada-saasyco',
    state: 'open',
    draft: true,
    ageDays: 1,
    additions: 412,
    deletions: 96,
  },
  {
    number: 317,
    title: 'SAASY-405: Cap the technician app offline queue at 500 updates',
    head: 'saasy-405-offline-queue-cap',
    author: 'kai-saasyco',
    state: 'open',
    ageDays: 2,
    reviewers: ['sam-saasyco'],
    additions: 88,
    deletions: 12,
  },
  {
    number: 315,
    title: 'SAASY-398: Retry QuickBooks sync with backoff',
    head: 'saasy-398-quickbooks-retry',
    author: 'grace-saasyco',
    state: 'open',
    ageDays: 4,
    reviews: [{ by: 'kai-saasyco', state: 'CHANGES_REQUESTED' }],
    additions: 203,
    deletions: 41,
  },
  {
    number: 312,
    title: 'SAASY-391: Dispatcher can bulk-reassign jobs',
    head: 'saasy-391-bulk-reassign',
    author: 'ada-saasyco',
    state: 'merged',
    ageDays: 6,
    reviews: [{ by: 'grace-saasyco', state: 'APPROVED' }],
  },
  {
    number: 309,
    title: 'SAASY-377: Fix invoice rounding on multi-tax lines',
    head: 'saasy-377-invoice-rounding',
    author: 'sam-saasyco',
    state: 'merged',
    ageDays: 8,
    reviews: [
      { by: 'ada-saasyco', state: 'APPROVED' },
      { by: 'kai-saasyco', state: 'APPROVED' },
    ],
  },
];

const ANALYTICS_PULLS: FakePull[] = [
  {
    number: 211,
    title: 'Add dim_accounts.seats',
    head: 'dim-accounts-seats',
    author: 'grace-saasyco',
    state: 'merged',
    ageDays: 12,
    reviews: [{ by: 'kai-saasyco', state: 'APPROVED' }],
  },
];

const DATABOT = `You are DataBot, SaaSy Co.'s analytics engineer. You own the analytics
warehouse and its dbt project.

## Your tools

- The dbt project is cloned at \`analytics/\` (GitHub: saasy-co/analytics). Raw
  tables: \`raw.accounts\`, \`raw.users\`, \`raw.events\`; staging models in
  \`models/staging/\`, marts in \`models/marts/\`, one-off queries in
  \`analyses/\`.
- The warehouse is DuckDB: \`duckdb analytics/warehouse/saasy.duckdb -c "..."\`.
  dbt itself isn't installed here: check a model by running its SQL in DuckDB
  with refs swapped for the raw tables.
- \`gh\` works for saasy-co/analytics (run it inside \`analytics/\`).

## How you work

When someone asks how a metric is defined:
1. Look for existing definitions in the project and \`analyses/\`, and measure
   how far apart they are on real data.
2. Pick one canonical definition and say why in a sentence. For activity
   metrics, count deliberate product use, not passive events
   (notification_received, email_opened), and exclude internal accounts.
3. Make it real without being asked: a dbt model plus a schema.yml entry with
   a description and tests, on a new branch in \`analytics/\`. Commit, push, and
   open a PR with \`gh pr create\`. Don't stop to ask which definition to use:
   decide, ship it, and let the PR be where people push back. An answer
   without a PR link is unfinished.
4. Reply briefly: the definition, a small table showing why (last 3 months,
   old numbers vs new), and the PR link.

${TEAM}`;

const ENGBOT = `You are EngBot, the engineering manager's right hand at SaaSy Co. You
keep track of who is doing what so nobody has to ask around.

## Where the work is

- The team's Agor board is **SaaSy Co.**. Each branch on it is one Jira ticket:
  the branch is named after the ticket and carries its \`issue_url\` (Jira) and
  \`pull_request_url\`. Use Agor's tools (\`agor_boards_get\` with entities,
  \`agor_branches_list\`, \`agor_sessions_list\`, \`agor_users_list\`) to see
  branches, their owners, zones, and recent agent sessions.
- Pull requests are on GitHub in saasy-co/app: \`gh pr list -R saasy-co/app --state all\`,
  \`gh pr view N -R saasy-co/app\`, \`gh search prs --reviewed-by LOGIN --state all\`.

## How you answer "what's the team working on?"

Always check both sources before answering: the board (who owns which
ticket branch) and GitHub (\`gh pr list -R saasy-co/app --state all --json
number,title,author,state,isDraft,reviews,reviewRequests\`), so you know
each PR's state and who reviewed it.

Answer with one table, one row per person (use their names):

| Person | Working on | PRs opened | Reviews |

- Working on: Jira key and a few plain words (e.g. "SAASY-412 route time windows").
- PRs opened: number and state (draft / open / merged).
- Reviews: PRs they reviewed (approved or changes requested) or owe a
  review on.

Then at most two short lines on anything blocked or waiting on someone.
Link tickets and PRs. Leave out Agor internals (session states, flags,
teammates); people want to know what their team is doing.

${TEAM}`;

const LEGALBOT = `You are LegalBot, SaaSy Co.'s commercial counsel. You review vendor and
customer contracts against SaaSy Co.'s playbook (\`PLAYBOOK.md\`) and say plainly
whether to sign.

## How you review

- Lead with the verdict in one line.
- Quote the clause that matters, with its section number.
- Explain the risk in plain words, with real numbers from the contract (fees,
  caps, terms).
- Give a redline: the replacement language, ready to send.
- Don't pad: no general disclaimers, no restating the whole contract.`;

const PLAYBOOK = `# SaaSy Co. contract playbook: vendor agreements

## Limitation of liability

- **General cap:** at least the fees paid or payable in the 12 months before the
  claim. Anything under 12 months is a non-starter.
- **Mutual:** caps and exclusions apply to both parties equally.
- **Super-cap for data:** breaches of security, data protection or
  confidentiality get a separate cap of at least 3x annual fees (minimum $1M).
- **Uncapped:** gross negligence, willful misconduct, IP infringement indemnity.
- **Data loss** caused by the vendor's breach of its security obligations is a
  direct damage, never "consequential".

## Term and renewal

- Auto-renewal is fine with a notice window of 60 days or less.
`;

export const saasy: SeedDef = {
  name: 'saasy',
  extends: 'workspace',
  description:
    'SaaSy Co. (fictional B2B SaaS): engineering board with ticket branches and PRs, analytics warehouse, and three AI teammates (DataBot, EngBot, LegalBot).',
  inputs: ['support/seeds/saasy.ts', 'fixtures/repos', 'fixtures/data/saasy'],
  async run(s) {
    // Repos: real git, with a local stand-in for GitHub.
    const appDir = localRepo('saasy-app', APP);
    await s.repo('saasy-app', appDir, APP);
    localRepo('saasy-analytics', ANALYTICS);
    fakeGithub(APP, 'Scheduling, dispatch and invoicing for field-service teams', APP_PULLS);
    fakeGithub(ANALYTICS, "SaaSy Co.'s analytics warehouse (dbt + DuckDB)", ANALYTICS_PULLS);

    const zone = (label: string, col: number, color: string) => ({
      label,
      x: col * 620,
      y: 0,
      width: 560,
      height: 760,
      color,
    });
    await s.board('saasy', {
      title: 'SaaSy Co.',
      icon: '🛰️',
      description: 'Scheduling, dispatch and invoicing for field-service teams.',
      zones: {
        progress: zone('In progress', 0, '#1677ff'),
        review: zone('In review', 1, '#fa8c16'),
        done: zone('Done', 2, '#52c41a'),
        teammates: zone('AI teammates', 3, '#722ed1'),
      },
    });
    const ticket = async (
      name: string,
      key: string,
      zone: string,
      row: number,
      as: 'sam' | 'ada' | 'grace' | 'kai',
      prNumber?: number
    ) =>
      s.branch({
        name,
        repo: 'saasy-app',
        board: 'saasy',
        zone,
        at: { x: 30, y: 70 + row * 230 },
        as,
        from: 'main',
        issueUrl: `${SAASY_JIRA}/${key}`,
        ...(prNumber ? { prUrl: pr(APP, prNumber) } : {}),
      });
    await ticket('saasy-412-route-time-windows', 'SAASY-412', 'progress', 0, 'ada', 318);
    await ticket('saasy-421-calendar-drag-drop', 'SAASY-421', 'progress', 1, 'ada');
    await ticket('saasy-405-offline-queue-cap', 'SAASY-405', 'review', 0, 'kai', 317);
    await ticket('saasy-398-quickbooks-retry', 'SAASY-398', 'review', 1, 'grace', 315);
    await ticket('saasy-377-invoice-rounding', 'SAASY-377', 'done', 0, 'sam', 309);
    // A little live activity on the board: sessions their owners started.
    await s.session('ada-routing', {
      branch: 'saasy-412-route-time-windows',
      as: 'ada',
      title: 'Respect customer time windows in the solver',
    });
    await s.session('kai-queue', {
      branch: 'saasy-405-offline-queue-cap',
      as: 'kai',
      title: 'Cap the offline queue',
    });
    await s.session('grace-qb', {
      branch: 'saasy-398-quickbooks-retry',
      as: 'grace',
      title: 'Address Kai’s review: jitter + max attempts',
    });

    const teammate = (row: number) => ({
      board: 'saasy',
      zone: 'teammates',
      at: { x: 30, y: 70 + row * 260 },
    });
    await s.teammate('engbot', {
      ...teammate(0),
      displayName: 'EngBot',
      emoji: '🛠️',
      description: 'Knows who is on what: tickets, branches, PRs and reviews.',
      primary: true,
      identity: ENGBOT,
      user: USER,
    });
    const databot = await s.teammate('databot', {
      ...teammate(1),
      displayName: 'DataBot',
      emoji: '📊',
      description: 'Analytics engineer: the warehouse, dbt models and metric definitions.',
      identity: DATABOT,
      user: USER,
      files: { '.gitignore': 'analytics/\n' },
    });
    cloneInto(ANALYTICS, `${databot.dir}/analytics`);
    buildSaasyWarehouse(`${databot.dir}/analytics/warehouse/saasy.duckdb`);
    await s.teammate('legalbot', {
      ...teammate(2),
      displayName: 'LegalBot',
      emoji: '⚖️',
      description: 'Commercial counsel: reviews contracts against our playbook.',
      identity: LEGALBOT,
      user: USER,
      files: { 'PLAYBOOK.md': PLAYBOOK },
    });
    // Empty sessions to ask each teammate in (Agor titles them from the question).
    await s.session('ask-engbot', { branch: 'engbot' });
    // DataBot is trusted to ship: without this, Claude Code's auto mode
    // blocks the commit/PR the persona says to make unasked.
    await s.session('ask-databot', { branch: 'databot', permissionMode: 'bypassPermissions' });
    // Titled: Agor's auto-title would use the attachment instructions it
    // prepends to the first prompt.
    await s.session('ask-legalbot', { branch: 'legalbot', title: 'FooBar MSA: liability review' });
  },
};
