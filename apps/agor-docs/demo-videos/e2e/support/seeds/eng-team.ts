// SaaSy Co.'s EngTeam board, for the "Multiply engineering throughput"
// section: a workflow board whose zones hand each ticket from agent to agent
// (Claude builds, Codex reviews, QA tests) until a person merges it.
//
// Three stacked seeds, one per stretch of the story (eng-board and eng-flow
// live in eng-flow.ts, so editing them never rebuilds this one: the
// recorded eng-build turns refer to its board by id):
// - eng-team:  the empty EngTeam board, SaaSy Co.'s backlog in GitHub and
//   Jira (both stand-ins, fixtures/bin), and EngBot as Sam's assistant with
//   the team's workflow, so "build me a kanban board" and "find 5 issues to
//   work on" are real turns (clip eng-build).
// - eng-board: the board those two turns make, built directly: the workflow
//   zones and five tickets in Backlog (clip eng-fanout drags them on).
// - eng-flow:  mid-flight: four tickets being built, one in Review with its
//   PR (the review loop, QA, deep review and merge clips puppeteer it).

import { readFileSync } from 'node:fs';
import { fakeGithub, fakeJira } from '../fixtures.ts';
import type { ZoneSpec } from '../seeder.ts';
import type { SeedDef } from '../seeds.ts';
import { GITHUB_ISSUES, JIRA_PEOPLE, JIRA_TICKETS } from './eng-backlog.ts';
import { APP, APP_PULLS } from './saasy.ts';

const col = (n: number) => n * 600;
const lane = (
  label: string,
  n: number,
  color: string,
  trigger?: { agent: string; template: string }
): ZoneSpec => ({
  label,
  x: col(n),
  y: 0,
  width: 560,
  height: 1180,
  color,
  ...(trigger ? { trigger: { ...trigger, behavior: 'always_new' as const } } : {}),
});

/** The team's workflow: what EngBot builds when asked for a kanban board. */
export const WORKFLOW: Record<string, ZoneSpec> = {
  backlog: lane('Backlog', 0, '#8c8c8c'),
  progress: lane('In Progress', 1, '#1677ff', {
    agent: 'claude-code',
    template: `Pick up {{branch.issue_url}}. Read the ticket, fix it with tests, push, and open a PR with gh pr create. Then move this branch to Review.`,
  }),
  review: lane('Review', 2, '#fa8c16', {
    agent: 'codex',
    template: `Review the PR {{branch.pull_request_url}} against {{branch.issue_url}}.
Passes: approve it and move this branch to QA.
Fails: request changes and move it back to In Progress.`,
  }),
  qa: lane('QA', 3, '#722ed1', {
    agent: 'claude-code',
    template: `Start this branch's shared environment, write a test plan for {{branch.issue_url}} and run it with Playwright.
All green: move to Ready to merge. Otherwise back to In Progress with what failed.`,
  }),
  ready: lane('Ready to merge', 4, '#13c2c2'),
  merged: lane('Merged', 5, '#52c41a'),
};

const zoneJson = JSON.stringify(
  Object.values(WORKFLOW).map((z) => ({
    type: 'zone',
    label: z.label,
    x: z.x,
    y: z.y,
    width: z.width,
    height: z.height,
    borderColor: z.color,
    backgroundColor: `${z.color}1a`,
    ...(z.trigger ? { trigger: z.trigger } : {}),
  })),
  null,
  2
);

const WORKFLOW_MD = `# The engineering team's workflow

The team's board is **EngTeam** (a board of its own, separate from SaaSy Co.).
"The board" or "our board" means EngTeam unless Sam names another.

## "Build me a kanban board"

Lay the EngTeam board out as the team's workflow: add these zones exactly as
given (agor_boards_update with upsertObjects, one zone object each, ids
\`zone-backlog\`, \`zone-progress\`, \`zone-review\`, \`zone-qa\`, \`zone-ready\`,
\`zone-merged\`, in that order). Keep the triggers: they are what moves work
along without anyone asking.

\`\`\`json
${zoneJson}
\`\`\`

Reply in one line once it's done.

## "Find issues to work on"

Tickets live in two places: GitHub issues on ${APP} (\`gh issue list\`) and
Jira project SAASY (\`jira issue list -s "To Do"\`). Look at both, then pick
work an agent can finish today:
- bugs and well-scoped stories with a clear fix in saasy-app;
- skip anything that needs design, a product decision or a reproduction
  first, docs-only work, and anything already in progress.

For each pick, one at a time (wait for each call to return before the
next, so the cards stack instead of landing on top of each other), create a
branch on the EngTeam board in the Backlog zone
(agor_branches_create with repo saasy-co/app, sourceBranch main, the
board's id, zoneId \`zone-backlog\`, and issueUrl set to the ticket's URL).
Name branches after the ticket: \`saasy-<number>-<slug>\` for Jira,
\`gh-<number>-<slug>\` for GitHub, slugs of two to four words.

Then reply with a short table: ticket, source, why it's a good pick.
`;

export const engTeam: SeedDef = {
  name: 'eng-team',
  extends: 'saasy',
  // eng-build's recorded turns name this seed's board and teammate by id.
  pin: '1',
  description:
    'SaaSy Co. plus an empty EngTeam board, a backlog in GitHub issues and Jira, and EngBot as Sam’s assistant with the team’s workflow.',
  inputs: ['support/seeds/eng-team.ts', 'support/seeds/eng-backlog.ts', 'fixtures/bin'],
  async run(s) {
    fakeGithub(
      APP,
      'Scheduling, dispatch and invoicing for field-service teams',
      APP_PULLS,
      GITHUB_ISSUES
    );
    fakeJira({
      key: 'SAASY',
      name: 'SaaSy App',
      lead: 'Sam Rivera',
      statuses: ['To Do', 'In Progress', 'In Review', 'Done'],
      people: JIRA_PEOPLE,
      tickets: JIRA_TICKETS,
    });
    await s.board('eng', {
      title: 'EngTeam',
      icon: '🚀',
      description: 'Every ticket from Backlog to Merged, with agents on each step.',
    });

    // EngBot learns the workflow, and is who Sam's Compose button asks.
    s.commit('engbot', { 'WORKFLOW.md': WORKFLOW_MD }, 'Add the team workflow');
    const engbot = s.world.branch('engbot');
    const agents = readFileSync(`${engbot.dir}/AGENTS.md`, 'utf8');
    s.commit(
      'engbot',
      {
        'AGENTS.md': `${agents.trimEnd()}\n\nWhen Sam asks you to build a board or find work, follow WORKFLOW.md exactly.\n`,
      },
      'Point EngBot at the workflow'
    );
    const sam = await s.as('sam');
    const samId = await s.userId('sam');
    await sam.custom('/users', 'setPrimaryTeammate', {
      branchId: engbot.id,
      expectedUserId: samId,
    });
    await sam.patch(`/users/${samId}`, {
      // Compose starts sessions with the user's defaults: EngBot runs gh,
      // jira and Agor's tools without stopping to ask.
      default_agentic_config: { 'claude-code': { permissionMode: 'bypassPermissions' } },
    });
  },
};
