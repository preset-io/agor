/**
 * Example board fixture: one made-up week at Northwind with Wendy, a research
 * and launch teammate. Content owner: design (see onboarding-design.md).
 *
 * `board` is a BoardExportBlob; the rest extends it with the rows a board
 * export does not carry yet. Keys are fixture-local and become fresh IDs when
 * seeded. Bump `version` when the shape changes.
 */
import type { BoardExportBlob } from '../../types/board';
import type { ChannelType } from '../../types/gateway';

export const EXAMPLE_BOARD_FIXTURE_VERSION = 1;

/** One transcript step. `user` opens the task with the full prompt. */
export type ExampleTurn =
  | { user: string }
  | { text: string }
  | { tool: string; input: Record<string, unknown>; output: string };

export interface ExampleSession {
  key: string;
  branch: string;
  /** Short, readable title; the first `user` turn holds the full prompt. */
  title: string;
  minutesAgo: number;
  durationSeconds: number;
  turns: ExampleTurn[];
  spawnedFrom?: string;
  forkedFrom?: string;
  schedule?: string;
  gateway?: { channel_type: ChannelType; channel_name: string };
}

export interface ExampleBoardFixture {
  version: typeof EXAMPLE_BOARD_FIXTURE_VERSION;
  board: BoardExportBlob;
  repo: { slug: string; name: string; remote_url: string };
  branches: Array<{
    key: string;
    name: string;
    zone: string;
    position: { x: number; y: number };
    teammate?: { displayName: string; emoji: string };
    notes?: string;
  }>;
  cards: Array<{
    zone: string;
    position: { x: number; y: number };
    title: string;
    description: string;
    note: string;
    emoji: string;
    color: string;
  }>;
  artifacts: Array<{
    key: string;
    name: string;
    description: string;
    session: string;
    branch: string;
    position: { x: number; y: number; width: number; height: number };
    html: string;
  }>;
  schedules: Array<{
    key: string;
    branch: string;
    name: string;
    cron_expression: string;
    prompt: string;
  }>;
  sessions: ExampleSession[];
}

const zone = (label: string, color: string, x: number, y: number, w: number, h: number) => ({
  type: 'zone' as const,
  x,
  y,
  width: w,
  height: h,
  label,
  borderColor: color,
  backgroundColor: `${color}1a`,
  locked: true,
});

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:Inter,system-ui,sans-serif;color:#1f2933;background:#fff}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #e5e7eb}th{color:#6b7280;font-weight:600}</style></head><body>${body}</body></html>`;

export const EXAMPLE_BOARD_FIXTURE: ExampleBoardFixture = {
  version: EXAMPLE_BOARD_FIXTURE_VERSION,
  board: {
    name: "Wendy's board",
    slug: 'example-wendy',
    description: 'Example board: a research teammate at Northwind (made-up company)',
    icon: '🔭',
    color: '#722ed1',
    access_mode: 'shared',
    default_others_can: 'view',
    default_others_fs_access: 'none',
    objects: {
      'zone-inbox': { ...zone('Inbox', '#1677ff', 0, 0, 600, 760), layout: 'column' },
      'zone-in-progress': {
        ...zone('In progress', '#2e9a92', 640, 0, 1300, 760),
        layout: 'column',
      },
      'zone-review': { ...zone('Review', '#fa8c16', 1980, 0, 600, 760), layout: 'column' },
      'zone-done': { ...zone('Done this week', '#52c41a', 2620, 0, 600, 760), layout: 'column' },
      'zone-always-on': { ...zone('Always on', '#722ed1', 0, 800, 1300, 760), layout: 'grid' },
      'note-northwind': {
        type: 'markdown',
        x: 1340,
        y: 800,
        width: 420,
        content: [
          '## How Northwind uses Agor',
          '',
          'Maya (product), Theo (design) and Sam (engineering) share one teammate, Wendy.',
          '',
          '- Ask from Slack or here, Wendy picks it up.',
          '- Big asks split into sub-sessions that run side by side.',
          '- Try an idea without losing the original: fork the session.',
          '- Scheduled runs post a morning digest and refresh the metrics.',
          '',
          'Northwind and everyone here are made up.',
        ].join('\n'),
      },
    },
  },
  repo: {
    slug: 'example-northwind-web',
    name: 'northwind/web',
    remote_url: 'https://github.com/northwind-example/web.git',
  },
  branches: [
    {
      key: 'wendy',
      name: 'private-wendy',
      zone: 'zone-always-on',
      position: { x: 20, y: 80 },
      teammate: { displayName: 'Wendy', emoji: '🔭' },
      notes:
        'I research competitors, prep Maya’s meetings, post a morning digest and build quick launch prototypes for the Northwind team.',
    },
    { key: 'pricing', name: 'pricing-page-copy', zone: 'zone-inbox', position: { x: 20, y: 80 } },
    {
      key: 'landing',
      name: 'beta-landing-page',
      zone: 'zone-in-progress',
      position: { x: 20, y: 80 },
    },
    { key: 'changelog', name: 'october-changelog', zone: 'zone-done', position: { x: 20, y: 80 } },
  ],
  cards: [
    {
      zone: 'zone-inbox',
      position: { x: 20, y: 400 },
      title: 'Customer quote for the launch post',
      description: 'Ask two beta customers for a one-line quote. Wendy can draft the ask.',
      note: 'Owner: Maya. Due Thursday.',
      emoji: '📝',
      color: '#1677ff',
    },
    {
      zone: 'zone-inbox',
      position: { x: 20, y: 560 },
      title: 'Beta FAQ: top 10 questions',
      description: 'Pull the most common questions from #beta-feedback and support tickets.',
      note: 'Owner: Sam. Due Friday.',
      emoji: '📝',
      color: '#1677ff',
    },
    {
      zone: 'zone-review',
      position: { x: 20, y: 80 },
      title: 'Legal review of beta terms',
      description: 'Approved by legal on Monday. Two wording changes, both applied.',
      note: 'Owner: Maya. Done.',
      emoji: '✅',
      color: '#fa8c16',
    },
    {
      zone: 'zone-review',
      position: { x: 20, y: 240 },
      title: 'Pricing page copy approved',
      description: 'Waiting on Wendy’s pricing copy session in Inbox. Maya signs off.',
      note: 'Owner: Maya. In review.',
      emoji: '🚀',
      color: '#fa8c16',
    },
    {
      zone: 'zone-review',
      position: { x: 20, y: 400 },
      title: 'Announcement draft to Maya',
      description: 'Short post for the blog and LinkedIn. Uses the landing page hero.',
      note: 'Owner: Theo. Not started.',
      emoji: '🚀',
      color: '#fa8c16',
    },
  ],
  artifacts: [
    {
      key: 'landing',
      name: 'Beta landing page',
      description: 'Prototype of the Northwind beta landing page',
      session: 'landing',
      branch: 'landing',
      position: { x: 1240, y: 80, width: 660, height: 380 },
      html: page(
        '<main style="padding:48px 40px;background:#0f2a44;color:#fff;min-height:100vh;box-sizing:border-box"><p style="color:#5eead4;font-weight:600;margin:0">Northwind beta</p><h1 style="font-size:36px;margin:12px 0">Plan your launch in 10 minutes.</h1><p style="opacity:.8;max-width:420px">One shared space for your launch plan, checklist and announcements.</p><ul style="opacity:.9;line-height:1.8;padding-left:18px"><li>Start from a plan that works</li><li>See who owns what</li><li>Ship the post on time</li></ul><form onsubmit="return false" style="display:flex;gap:8px;margin-top:20px"><input placeholder="you@company.com" style="padding:10px 12px;border-radius:8px;border:0;width:220px"><button style="padding:10px 16px;border-radius:8px;border:0;background:#2e9a92;color:#fff;font-weight:600">Join the waitlist</button></form></main>'
      ),
    },
    {
      key: 'tracker',
      name: 'Competitor tracker',
      description: 'Pricing and launches at Acorn, Brightline and Copperleaf',
      session: 'competitors',
      branch: 'wendy',
      position: { x: 1240, y: 480, width: 660, height: 260 },
      html: page(
        '<div style="padding:16px"><table><thead><tr><th>Company</th><th>Team plan</th><th>Free trial</th><th>This week</th></tr></thead><tbody><tr><td>Acorn</td><td>$12 per seat <b style="color:#dc2626">(was $15)</b></td><td>14 days</td><td>Price cut on Oct 22</td></tr><tr><td>Brightline</td><td>$18 per seat</td><td>7 days</td><td>AI meeting summaries, beta</td></tr><tr><td>Copperleaf</td><td>Sales only</td><td>None</td><td>Hiring 3 sales roles in Europe</td></tr><tr><td>Northwind</td><td>$14 per seat</td><td>14 days</td><td>Beta landing page in review</td></tr></tbody></table></div>'
      ),
    },
    {
      key: 'metrics',
      name: 'Weekly metrics',
      description: 'Beta signups for the last 8 weeks',
      session: 'metrics',
      branch: 'wendy',
      position: { x: 620, y: 880, width: 640, height: 300 },
      html: page(
        '<div style="padding:16px"><p style="margin:0 0 4px;font-weight:600">Beta signups</p><p style="margin:0 0 12px;color:#6b7280;font-size:13px">412 this week, up 18%. Waitlist conversion 31%.</p><svg viewBox="0 0 320 120" width="100%" height="160" role="img" aria-label="Signups per week, rising from 120 to 412"><g fill="#2e9a92">' +
          [120, 150, 170, 210, 250, 300, 349, 412]
            .map((v, i) => {
              const h = Math.round((v / 412) * 110);
              return `<rect x="${i * 40 + 6}" y="${120 - h}" width="28" height="${h}" rx="3"/>`;
            })
            .join('') +
          '</g></svg></div>'
      ),
    },
  ],
  schedules: [
    {
      key: 'digest',
      branch: 'wendy',
      name: 'Morning digest',
      cron_expression: '0 8 * * 1-5',
      prompt: 'Post the morning digest to #team: launches, blockers and what changed overnight.',
    },
    {
      key: 'metrics',
      branch: 'wendy',
      name: 'Weekly metrics refresh',
      cron_expression: '0 16 * * 5',
      prompt: 'Refresh the weekly metrics artifact from the beta signups sheet.',
    },
  ],
  sessions: [
    {
      key: 'competitors',
      branch: 'wendy',
      title: 'Competitor changes this week',
      minutesAgo: 190,
      durationSeconds: 400,
      gateway: { channel_type: 'slack', channel_name: 'launch' },
      turns: [
        {
          user: '@Wendy what changed at our 3 competitors this week? Pricing, launches, anything we should react to before the beta.',
        },
        {
          text: 'I’ll check Acorn, Brightline and Copperleaf at the same time, one sub-session each.',
        },
        {
          tool: 'agor_sessions_spawn',
          input: { titles: ['Acorn', 'Brightline', 'Copperleaf'] },
          output: '3 sub-sessions started',
        },
        {
          tool: 'agor_artifacts_update',
          input: { artifact: 'Competitor tracker' },
          output: 'Updated 5 rows and the price chart',
        },
        {
          text: [
            'Three changes worth knowing:',
            '',
            '- Acorn cut its team plan from $15 to $12 per seat. Expect price questions from Acme.',
            '- Brightline launched AI meeting summaries, beta only, waitlist open.',
            '- Copperleaf: no product changes. Hiring 3 sales roles in Europe.',
            '',
            'The competitor tracker is updated, and I posted a summary in #launch.',
          ].join('\n'),
        },
      ],
    },
    {
      key: 'acorn',
      branch: 'wendy',
      spawnedFrom: 'competitors',
      title: 'Acorn cut its price to $12',
      minutesAgo: 189,
      durationSeconds: 130,
      turns: [
        { user: 'Check Acorn’s pricing page, changelog and blog for changes since Oct 20.' },
        {
          tool: 'WebFetch',
          input: { url: 'https://acorn.example/pricing' },
          output: 'Team plan $12 per seat (was $15)',
        },
        {
          text: 'Acorn cut the team plan to $12 per seat on Oct 22. Two small changelog entries, both bug fixes.',
        },
      ],
    },
    {
      key: 'brightline',
      branch: 'wendy',
      spawnedFrom: 'competitors',
      title: 'Brightline AI summaries beta',
      minutesAgo: 189,
      durationSeconds: 151,
      turns: [
        { user: 'Check Brightline’s pricing page, changelog and blog for changes since Oct 20.' },
        {
          tool: 'WebFetch',
          input: { url: 'https://brightline.example/blog' },
          output: 'New post: AI meeting summaries',
        },
        {
          text: 'Brightline launched AI meeting summaries on Oct 23. Beta only, with a waitlist. Pricing unchanged.',
        },
      ],
    },
    {
      key: 'copperleaf',
      branch: 'wendy',
      spawnedFrom: 'competitors',
      title: 'Copperleaf hiring, no product news',
      minutesAgo: 189,
      durationSeconds: 108,
      turns: [
        { user: 'Check Copperleaf’s pricing page, changelog and blog for changes since Oct 20.' },
        {
          tool: 'WebFetch',
          input: { url: 'https://copperleaf.example/careers' },
          output: '3 new sales roles, Europe',
        },
        { text: 'No product or pricing changes. Three new sales roles in Berlin and London.' },
      ],
    },
    {
      key: 'digest',
      branch: 'wendy',
      schedule: 'digest',
      title: 'Morning digest',
      minutesAgo: 250,
      durationSeconds: 58,
      turns: [
        {
          user: 'Post the morning digest to #team: launches, blockers and what changed overnight.',
        },
        {
          tool: 'Slack',
          input: { read: ['#launch', '#eng', '#design'], since: '18:00 yesterday' },
          output: '42 messages',
        },
        {
          text: [
            'Good morning. 3 updates:',
            '',
            '- The landing page prototype is ready for review. Theo asked for a darker hero, I’m trying it.',
            '- Pricing page copy starts after Thursday’s review.',
            '- The October changelog is merged (PR #476).',
          ].join('\n'),
        },
      ],
    },
    {
      key: 'metrics',
      branch: 'wendy',
      schedule: 'metrics',
      title: 'Weekly metrics',
      minutesAgo: 4 * 24 * 60,
      durationSeconds: 44,
      turns: [
        { user: 'Refresh the weekly metrics artifact from the beta signups sheet.' },
        {
          tool: 'Sheets',
          input: { sheet: 'Beta signups', range: 'last 8 weeks' },
          output: '8 rows',
        },
        { text: 'Signups grew 18% week over week, to 412. Waitlist conversion is flat at 31%.' },
      ],
    },
    {
      key: 'pricing',
      branch: 'pricing',
      title: 'Pricing copy for the beta',
      minutesAgo: 70,
      durationSeconds: 35,
      gateway: { channel_type: 'slack', channel_name: 'web' },
      turns: [
        {
          user: '@Wendy can you tighten the pricing page copy for the beta? Under 60 words per plan.',
        },
        { tool: 'Read', input: { file_path: 'site/pricing.md' }, output: '3 plans, 184 words' },
        {
          text: 'Plan: cut each plan to 3 lines, lead with time saved (from Northwind positioning), keep prices as they are. I’ll start once the landing page is reviewed on Thursday.',
        },
      ],
    },
    {
      key: 'landing',
      branch: 'landing',
      title: 'Beta landing page prototype',
      minutesAgo: 20 * 60,
      durationSeconds: 425,
      turns: [
        {
          user: 'Build a landing page prototype for the beta. One hero, three benefits, a waitlist form. Use our brand tokens.',
        },
        { tool: 'Read', input: { file_path: 'brand/tokens.css' }, output: '48 tokens' },
        {
          tool: 'Write',
          input: { file_path: 'beta/index.html' },
          output: 'Created beta/index.html',
        },
        {
          text: 'The prototype is live as an artifact on the board. Hero line: “Plan your launch in 10 minutes.” The form posts to the waitlist sheet.',
        },
      ],
    },
    {
      key: 'dark-hero',
      branch: 'landing',
      forkedFrom: 'landing',
      title: 'Darker hero variant',
      minutesAgo: 110,
      durationSeconds: 210,
      turns: [
        { user: 'Try a darker hero: navy background, white headline, keep the teal button.' },
        {
          tool: 'Edit',
          input: { file_path: 'beta/hero.css' },
          output: 'Updated beta/hero.css (+12 −4)',
        },
        {
          text: 'Switched the hero to navy with a white headline. The teal button passes contrast (4.8 to 1). The artifact shows the darker version.',
        },
      ],
    },
    {
      key: 'changelog',
      branch: 'changelog',
      title: 'October changelog',
      minutesAgo: 2 * 24 * 60,
      durationSeconds: 220,
      turns: [
        {
          user: 'Write the October changelog from merged PRs. Plain words, no ticket numbers.',
        },
        {
          tool: 'Bash',
          input: { command: 'gh pr list --state merged --search "merged:>=2026-10-01"' },
          output: '14 pull requests',
        },
        { tool: 'Write', input: { file_path: 'CHANGELOG.md' }, output: 'CHANGELOG.md +38' },
        {
          text: 'Done. 14 changes grouped under New, Better and Fixed. PR #476 is open for Sam, and he merged it.',
        },
      ],
    },
  ],
};
