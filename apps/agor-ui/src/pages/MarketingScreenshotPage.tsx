// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing screenshot palette
import type {
  ActiveUser,
  Board,
  BoardComment,
  BoardEntityObject,
  BoardID,
  Branch,
  BranchID,
  CardWithType,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { SessionStatus, shortId } from '@agor-live/client';
import { App as AntdApp, ConfigProvider, Layout, theme } from 'antd';
import { useEffect, useMemo } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { AppHeader } from '../components/AppHeader';
import { SessionCanvas } from '../components/SessionCanvas';
import type { StaticRemoteCursor } from '../components/SessionCanvas/canvas/RemoteCursorLayer';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import { agorStore } from '../store/agorStore';
import './MarketingScreenshotPage.css';

const now = '2026-06-21T06:00:00.000Z';
const boardId = '019ee88d-demo-board-0000-000000000001' as BoardID;
const repoId = '019ee88d-demo-repo-0000-000000000001';

const users = [
  { user_id: 'demo-user-max', name: 'Max', email: 'max@preset.io', emoji: '🧑‍🚀' },
  { user_id: 'demo-user-ari', name: 'Ari', email: 'ari@example.com', emoji: '🧠' },
  { user_id: 'demo-user-mina', name: 'Mina', email: 'mina@example.com', emoji: '🎨' },
  { user_id: 'demo-user-devon', name: 'Devon', email: 'devon@example.com', emoji: '🛠️' },
  { user_id: 'demo-user-kai', name: 'Kai', email: 'kai@example.com', emoji: '🚢' },
  { user_id: 'demo-user-jules', name: 'Jules', email: 'jules@example.com', emoji: '🔍' },
  { user_id: 'demo-user-sam', name: 'Sam', email: 'sam@example.com', emoji: '⚡' },
  { user_id: 'demo-user-rin', name: 'Rin', email: 'rin@example.com', emoji: '🧪' },
  { user_id: 'demo-user-noor', name: 'Noor', email: 'noor@example.com', emoji: '📝' },
  { user_id: 'demo-user-lina', name: 'Lina', email: 'lina@example.com', emoji: '🎯' },
  { user_id: 'demo-user-omar', name: 'Omar', email: 'omar@example.com', emoji: '🔧' },
  { user_id: 'demo-user-ivy', name: 'Ivy', email: 'ivy@example.com', emoji: '🌿' },
] as User[];

const board: Board = {
  board_id: boardId,
  name: 'Launch board',
  slug: 'launch-board',
  description: 'Landing-page staging board built from product canvas components.',
  icon: '🚢',
  color: '#14b8a6',
  access_mode: 'shared',
  created_at: now,
  last_updated: now,
  created_by: users[0].user_id,
  archived: false,
  url: '/demo/marketing-screenshots',
  background_color: 'linear-gradient(135deg, #f5af19 0%, #f12711 30%, #f5af19 60%, #f12711 100%)',
  objects: {
    'zone-ship': {
      type: 'zone',
      x: 60,
      y: 650,
      width: 680,
      height: 1080,
      label: '🚢 Ship this week',
      borderColor: '#fde047',
      backgroundColor: 'rgba(120,53,15,0.24)',
      locked: true,
      trigger: {
        behavior: 'show_picker',
        agent: 'claude-code',
        template: 'Polish {{branch.name}} for the landing-page hero crop.',
      },
    },
    'zone-review': {
      type: 'zone',
      x: 820,
      y: 650,
      width: 680,
      height: 1080,
      label: '🔎 Review lane',
      borderColor: '#fed7aa',
      backgroundColor: 'rgba(127,29,29,0.26)',
      locked: true,
      trigger: {
        behavior: 'always_new',
        agent: 'codex',
        template: 'Run a security/docs pass on {{branch.name}} and leave concise review notes.',
      },
    },
    'zone-teammates': {
      type: 'zone',
      x: 1580,
      y: 650,
      width: 1400,
      height: 1080,
      label: '🤖 Teammates + artifacts',
      borderColor: '#f472b6',
      backgroundColor: 'rgba(88,28,135,0.16)',
      locked: true,
      trigger: {
        behavior: 'show_picker',
        agent: 'gemini',
        template: 'Turn this branch into an artifact or status summary for the board.',
      },
    },
    'app-usage-cockpit': {
      type: 'app',
      x: 620,
      y: 80,
      width: 780,
      height: 495,
      title: 'Agent cost cockpit artifact',
      description: 'Published by an AI teammate as a live board artifact.',
      template: 'react',
      showEditor: false,
      showConsole: false,
      entryFile: '/App.js',
      files: {
        '/App.js': `
          import './styles.css';

          const burndown = [
            [34, 42], [92, 35], [150, 31], [208, 26], [266, 22], [324, 16], [382, 9], [440, 5],
          ];
          const claude = [
            [34, 118], [92, 96], [150, 104], [208, 72], [266, 78], [324, 52], [382, 48], [440, 30],
          ];
          const codex = [
            [34, 132], [92, 126], [150, 108], [208, 112], [266, 86], [324, 88], [382, 61], [440, 54],
          ];
          const toPath = (points) => points.map(([x, y], index) => \`\${index ? 'L' : 'M'}\${x} \${y}\`).join(' ');

          export default function App() {
            return (
              <main className="artifact">
                <header>
                  <div>
                    <p>Live artifact</p>
                    <h1>Agent burndown</h1>
                  </div>
                  <span className="pill">9 sessions</span>
                </header>
                <section className="summary">
                  <div><small>Open prompts</small><strong>5</strong></div>
                  <div><small>Claude Code</small><strong>3</strong></div>
                  <div><small>Codex</small><strong>4</strong></div>
                  <div><small>Other</small><strong>2</strong></div>
                </section>
                <svg viewBox="0 0 480 170" className="chart" role="img" aria-label="Burndown chart by agent">
                  <defs>
                    <linearGradient id="area" x1="0" x2="0" y1="0" y2="1">
                      <stop stopColor="#14b8a6" stopOpacity=".45" />
                      <stop offset="1" stopColor="#14b8a6" stopOpacity=".02" />
                    </linearGradient>
                    <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                  </defs>
                  {[34,92,150,208,266,324,382,440].map((x) => <line key={x} x1={x} x2={x} y1="18" y2="148" />)}
                  <path d={\`\${toPath(burndown)} L440 148 L34 148 Z\`} fill="url(#area)" />
                  <path d={toPath(claude)} className="claude" />
                  <path d={toPath(codex)} className="codex" />
                  <path d={toPath(burndown)} className="burn" filter="url(#glow)" />
                  {burndown.map(([x, y]) => <circle key={x} cx={x} cy={y} r="4" />)}
                </svg>
                <footer>
                  <span><i className="burn-dot" /> remaining work</span>
                  <span><i className="claude-dot" /> claude-code</span>
                  <span><i className="codex-dot" /> codex</span>
                </footer>
              </main>
            );
          }
        `,
        '/styles.css': `
          body { margin:0; background:#06111f; color:#eaffff; font-family: Inter, ui-sans-serif, system-ui; }
          .artifact { min-height:100vh; box-sizing:border-box; padding:18px; background:radial-gradient(circle at 20% 10%, rgba(94,234,212,.32), transparent 34%), linear-gradient(135deg,#07111f,#111827 56%,#241005); border:1px solid rgba(255,255,255,.14); }
          header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
          p { margin:0; color:#93c5fd; text-transform:uppercase; font-size:10px; letter-spacing:.16em; font-weight:800; }
          h1 { margin:2px 0 0; font-size:24px; letter-spacing:-.04em; }
          .pill { color:#052e2b; background:#5eead4; padding:4px 9px; border-radius:999px; font-size:12px; font-weight:900; box-shadow:0 0 22px rgba(20,184,166,.35); }
          .summary { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:14px 0 8px; }
          .summary div { padding:10px; border-radius:14px; background:rgba(15,23,42,.82); border:1px solid rgba(255,255,255,.09); }
          small { display:block; color:#a7f3d0; font-size:10px; text-transform:uppercase; letter-spacing:.09em; white-space:nowrap; }
          strong { display:block; margin-top:4px; font-size:25px; line-height:1; color:#f8fafc; }
          .chart { width:100%; height:150px; overflow:visible; }
          line { stroke:rgba(255,255,255,.08); stroke-width:1; }
          path { fill:none; stroke-linecap:round; stroke-linejoin:round; stroke-width:4; }
          circle { fill:#14b8a6; stroke:#ecfeff; stroke-width:2; }
          .burn { stroke:#14b8a6; }
          .claude { stroke:#a78bfa; opacity:.78; stroke-dasharray:6 7; }
          .codex { stroke:#f59e0b; opacity:.82; stroke-dasharray:2 8; }
          footer { display:flex; gap:12px; align-items:center; color:#cbd5e1; font-size:11px; flex-wrap:wrap; }
          footer span { display:flex; align-items:center; gap:5px; }
          i { width:8px; height:8px; border-radius:99px; display:inline-block; }
          .burn-dot { background:#14b8a6; }.claude-dot { background:#a78bfa; }.codex-dot { background:#f59e0b; }
        `,
      },
    },

    'app-ai-cost-tracker': {
      type: 'app',
      x: 60,
      y: 80,
      width: 520,
      height: 300,
      title: 'AI cost tracker artifact',
      description: 'Companion cost dashboard published by an AI teammate.',
      template: 'react',
      showEditor: false,
      showConsole: false,
      entryFile: '/App.js',
      files: {
        '/App.js': `
          import './styles.css';

          const rows = [
            ['Claude Code', '$18.72', '43%', '#a78bfa'],
            ['Codex', '$12.90', '31%', '#14b8a6'],
            ['Other agents', '$10.56', '26%', '#f59e0b'],
          ];

          export default function App() {
            return (
              <main className="cost-card">
                <header><span>AI spend</span><b>Live</b></header>
                <section className="hero"><small>today</small><strong>$42.18</strong><em>4.7m tokens · 19 runs</em></section>
                <div className="meter"><i /></div>
                <div className="rows">
                  {rows.map(([label, cost, pct, color]) => (
                    <div className="row" key={label} style={{ '--color': color }}>
                      <span><i />{label}</span><b>{cost}</b><small>{pct}</small>
                    </div>
                  ))}
                </div>
              </main>
            );
          }
        `,
        '/styles.css': `
          body { margin:0; background:#07111f; color:#eaffff; font-family: Inter, ui-sans-serif, system-ui; }
          .cost-card { min-height:100vh; box-sizing:border-box; padding:18px; background:radial-gradient(circle at 85% 0%, rgba(251,191,36,.28), transparent 34%), linear-gradient(135deg,#08111f,#111827 58%,#241005); border:1px solid rgba(255,255,255,.14); }
          header { display:flex; justify-content:space-between; align-items:center; font-weight:900; letter-spacing:-.02em; }
          header span { font-size:22px; } header b { color:#06251f; background:#fde047; padding:4px 9px; border-radius:999px; font-size:12px; }
          .hero { margin:14px 0; padding:14px; border-radius:18px; background:rgba(15,23,42,.78); border:1px solid rgba(255,255,255,.09); }
          small { color:#a7f3d0; text-transform:uppercase; font-size:10px; letter-spacing:.12em; }
          strong { display:block; font-size:39px; line-height:1; margin:5px 0; }
          em { color:#cbd5e1; font-style:normal; font-size:12px; }
          .meter { height:10px; overflow:hidden; border-radius:99px; background:rgba(255,255,255,.10); margin:14px 0; }
          .meter i { display:block; width:78%; height:100%; border-radius:99px; background:linear-gradient(90deg,#a78bfa,#14b8a6,#f59e0b); box-shadow:0 0 20px rgba(20,184,166,.42); }
          .rows { display:grid; gap:8px; }
          .row { display:grid; grid-template-columns:1fr auto auto; align-items:center; gap:10px; padding:10px; border-radius:14px; background:rgba(2,6,23,.55); border:1px solid rgba(255,255,255,.08); }
          .row span { display:flex; align-items:center; gap:8px; font-size:12px; } .row i { width:8px; height:8px; border-radius:99px; background:var(--color); box-shadow:0 0 12px var(--color); }
          .row b { font-size:14px; } .row small { color:#cbd5e1; }
        `,
      },
    },
    'note-architecture': {
      type: 'markdown',
      x: 1440,
      y: 80,
      width: 500,
      content:
        '### Staged product architecture\n\n```mermaid\nflowchart LR\n  Header[AppHeader] --> Facepile[Facepile + overflow]\n  Board[SessionCanvas] --> Zones[Real zones]\n  Board --> Branches[Branch cards]\n  Board --> Artifacts[Board artifacts]\n  Presence[Static users] -.demo-only.-> Facepile\n  Cursors[3 static cursors] -.demo-only.-> Board\n```\n\nDemo fixtures stay behind an explicit demo route.',
    },
    'note-sequence': {
      type: 'markdown',
      x: 1980,
      y: 80,
      width: 500,
      content:
        '### Capture flow\n\n```mermaid\nsequenceDiagram\n  participant Max\n  participant UI as Demo route\n  participant Canvas as Product canvas\n  participant Shot as Playwright\n  Max->>UI: open demo route\n  UI->>Canvas: render branches, zones, notes\n  Canvas->>Canvas: mount burndown artifact\n  Shot->>UI: wait 7-10s\n  Shot-->>Max: board PNGs\n```\n\nThe live route is hardcoded for staging only.',
    },
  },
};

const repo: Repo = {
  repo_id: repoId,
  slug: 'preset-io/agor',
  name: 'preset-io/agor',
  repo_type: 'remote',
  remote_url: 'https://github.com/preset-io/agor.git',
  local_path: '/home/max/.agor/repos/preset-io/agor',
  default_branch: 'main',
  created_at: now,
  updated_at: now,
  created_by: users[0].user_id,
  archived: false,
} as unknown as Repo;

interface BranchFixture {
  id: string;
  name: string;
  ref: string;
  zoneId: string;
  position: { x: number; y: number };
  issue: string;
  pr?: string;
  notes: string;
  env: { status: string; url: string };
  sessions: ReadonlyArray<readonly [string, string, string, string, boolean?]>;
}

const branchFixtures = [
  {
    id: '019ee88d-demo-branch-0000-000000000101',
    name: 'landing-hero-polish',
    ref: 'landing-hero-polish',
    zoneId: 'zone-ship',
    position: { x: 70, y: 110 },
    issue: 'https://github.com/preset-io/agor/issues/214',
    pr: 'https://github.com/preset-io/agor/pull/1248',
    notes:
      '**Goal:** make the homepage crop feel alive. Hero copy tightened, CTA contrast updated, final crop pending.',
    env: { status: 'running', url: 'http://localhost:5174' },
    sessions: [
      ['Claude', 'claude-code', SessionStatus.COMPLETED, 'tightening hero copy'],
      ['Codex', 'codex', SessionStatus.COMPLETED, 'responsive CSS pass'],
      ['Gemini', 'gemini', SessionStatus.IDLE, 'visual critique', true],
    ],
  },
  {
    id: '019ee88d-demo-branch-0000-000000000102',
    name: 'multiplayer-presence',
    ref: 'multiplayer-presence',
    zoneId: 'zone-ship',
    position: { x: 70, y: 520 },
    issue: 'https://linear.app/agor/issue/AG-220',
    pr: 'https://github.com/preset-io/agor/pull/1251',
    notes:
      'Static fixture drives the live facepile/cursor components for deterministic staging. Product presence behavior remains unchanged.',
    env: { status: 'running', url: 'http://localhost:9182' },
    sessions: [
      ['Codex', 'codex', SessionStatus.RUNNING, 'cursor layer fixture'],
      ['Claude', 'claude-code', SessionStatus.COMPLETED, 'facepile polish', true],
    ],
  },
  {
    id: '019ee88d-demo-branch-0000-000000000103',
    name: 'rbac-terminal-safe-defaults',
    ref: 'rbac-terminal-safe-defaults',
    zoneId: 'zone-review',
    position: { x: 80, y: 130 },
    issue: 'https://github.com/preset-io/agor/issues/42',
    pr: 'https://github.com/preset-io/agor/pull/1254',
    notes:
      'Review lane fan-out: sudoers warning copy drafted, docs link attached, awaiting a second pass.',
    env: { status: 'starting', url: 'http://localhost:3030' },
    sessions: [
      ['Claude', 'claude-code', SessionStatus.COMPLETED, 'sudoers audit'],
      ['OpenCode', 'opencode', SessionStatus.AWAITING_PERMISSION, 'waiting on ops note'],
    ],
  },
  {
    id: '019ee88d-demo-branch-0000-000000000104',
    name: 'usage-dashboard-artifact',
    ref: 'usage-dashboard-artifact',
    zoneId: 'zone-teammates',
    position: { x: 90, y: 120 },
    issue: 'https://linear.app/agor/issue/AG-198',
    pr: 'https://github.com/preset-io/agor/pull/1244',
    notes:
      'Agent-authored dashboard card is pinned below the branch. Synthetic data is OK for landing-page staging.',
    env: { status: 'running', url: 'http://localhost:7341' },
    sessions: [
      ['Gemini', 'gemini', SessionStatus.COMPLETED, 'chart artifact published'],
      ['Codex', 'codex', SessionStatus.IDLE, 'wire cost cards', true],
    ],
  },
  {
    id: '019ee88d-demo-branch-0000-000000000105',
    name: 'teammate-heartbeat',
    ref: 'teammate-heartbeat',
    zoneId: 'zone-teammates',
    position: { x: 90, y: 510 },
    issue: 'https://linear.app/agor/issue/BOT-17',
    notes:
      'Scheduled AI teammate heartbeat: daily backlog scan, Slack digest ready, three branches spawned for follow-up.',
    env: { status: 'stopped', url: 'http://localhost:7777' },
    sessions: [
      ['Claude', 'claude-code', SessionStatus.IDLE, 'daily backlog scan'],
      ['Codex', 'codex', SessionStatus.COMPLETED, 'triage report'],
      ['Gemini', 'gemini', SessionStatus.COMPLETED, 'summarize risks'],
    ],
  },
] as const satisfies readonly BranchFixture[];

const branches = branchFixtures.map(
  (fixture, index) =>
    ({
      branch_id: fixture.id as BranchID,
      repo_id: repoId,
      branch_unique_id: 1200 + index,
      created_at: now,
      updated_at: now,
      created_by: users[index % users.length].user_id,
      name: fixture.name,
      ref: fixture.ref,
      ref_type: 'branch',
      path: `/home/max/.agor/worktrees/preset-io/agor/${fixture.name}`,
      base_ref: 'main',
      base_sha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      last_commit_sha: '8f14e45fceea167a5a36dedd4bea2543a6f7dabc',
      tracking_branch: `origin/${fixture.ref}`,
      new_branch: true,
      board_id: boardId,
      issue_url: fixture.issue,
      pull_request_url: 'pr' in fixture ? fixture.pr : undefined,
      notes: fixture.notes,
      environment_instance: {
        instance_id: `env-${fixture.id}`,
        branch_id: fixture.id,
        status: fixture.env.status,
        url: fixture.env.url,
        ports: [],
        env_vars: {},
        created_at: now,
        updated_at: now,
      },
      last_used: now,
      needs_attention: index === 1,
      archived: false,
      filesystem_status: 'ready',
      others_can: 'session',
      url: `/ui/w/${shortId(fixture.id)}`,
    }) as unknown as Branch
);

const boardEntityObjects: BoardEntityObject[] = branchFixtures.map((fixture) => ({
  object_id: `board-object-${fixture.id}`,
  board_id: boardId,
  branch_id: fixture.id as BranchID,
  entity_type: 'branch',
  position: fixture.position,
  zone_id: fixture.zoneId,
  created_at: now,
}));

const sessions = branchFixtures.flatMap((fixture, branchIndex) =>
  fixture.sessions.map(
    ([title, tool, status, description, readyForPrompt], sessionIndex) =>
      ({
        session_id: `${fixture.id}-session-${sessionIndex + 1}`,
        agentic_tool: tool,
        status,
        created_at: now,
        last_updated: now,
        created_by: users[(branchIndex + sessionIndex) % users.length].user_id,
        unix_username: null,
        branch_id: fixture.id as BranchID,
        branch_board_id: boardId,
        url: `/ui/s/${shortId(fixture.id)}${sessionIndex}`,
        git_state: {
          ref: fixture.ref,
          base_sha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
          current_sha: '8f14e45fceea167a5a36dedd4bea2543a6f7dabc',
        },
        contextFiles: [],
        genealogy: { children: [] },
        tasks: [],
        title: `${title}: ${description}`,
        description,
        ready_for_prompt: readyForPrompt === true,
        archived: false,
      }) as unknown as Session
  )
);

const cards = [
  {
    card_id: '019ee88d-demo-card-0000-000000000201',
    board_id: boardId,
    title: 'Landing page launch checklist',
    description: 'Crop variants, homepage placement, facepile state, board density, and docs copy.',
    note: 'Mina: wide crop reads best. Keep cursor labels visible but not covering PR pills.',
    effective_emoji: '✅',
    effective_color: '#14b8a6',
    created_by: users[2].user_id,
    created_at: now,
    updated_at: now,
    archived: false,
  },
  {
    card_id: '019ee88d-demo-card-0000-000000000202',
    board_id: boardId,
    title: 'Usage cockpit artifact',
    description: 'Agent-authored dashboard preview with cost, token, and run counters.',
    note: 'Published by Gemini, wired by Codex, ready for the docs-site hero assets.',
    effective_emoji: '📊',
    effective_color: '#06b6d4',
    created_by: users[5].user_id,
    created_at: now,
    updated_at: now,
    archived: false,
  },
  {
    card_id: '019ee88d-demo-card-0000-000000000203',
    board_id: boardId,
    title: 'Security review prompt template',
    description: 'Zone trigger prompt for RBAC, terminal, and Unix isolation changes.',
    note: 'Drop any branch into Review lane to spawn Claude + Codex with audit context.',
    effective_emoji: '🔐',
    effective_color: '#f59e0b',
    created_by: users[6].user_id,
    created_at: now,
    updated_at: now,
    archived: false,
  },
] as unknown as CardWithType[];

const cardObjects: BoardEntityObject[] = [
  {
    object_id: 'board-object-card-201',
    board_id: boardId,
    card_id: cards[0].card_id,
    entity_type: 'card',
    position: { x: 80, y: 900 },
    zone_id: 'zone-teammates',
    created_at: now,
  },
  {
    object_id: 'board-object-card-202',
    board_id: boardId,
    card_id: cards[1].card_id,
    entity_type: 'card',
    position: { x: 80, y: 750 },
    zone_id: 'zone-teammates',
    created_at: now,
  },
  {
    object_id: 'board-object-card-203',
    board_id: boardId,
    card_id: cards[2].card_id,
    entity_type: 'card',
    position: { x: 120, y: 540 },
    zone_id: 'zone-review',
    created_at: now,
  },
];

const comments = [
  {
    comment_id: '019ee88d-demo-comment-0000-000000000301',
    board_id: boardId,
    created_by: users[2].user_id,
    content: 'Can we keep the facepile capped but still show the +7 overflow?',
    content_preview: 'Can we keep the facepile capped but still show the +7 overflow?',
    branch_id: branchFixtures[1].id as BranchID,
    resolved: false,
    edited: false,
    reactions: [{ user_id: users[0].user_id, emoji: '👍' }],
    position: {
      relative: {
        parent_id: branchFixtures[1].id,
        parent_type: 'branch',
        offset_x: 420,
        offset_y: 80,
      },
    },
    mentions: [users[0].user_id],
    created_at: new Date(now),
  },
] as unknown as BoardComment[];

const activeUsers: ActiveUser[] = users.map((user, index) => ({
  user,
  lastSeen: Date.now() - index * 1_000,
  boardId,
  cursor: { x: 420 + index * 42, y: 180 + (index % 3) * 84 },
}));

const staticCursors: StaticRemoteCursor[] = [
  { userId: users[1].user_id, user: users[1], color: '#06b6d4', x: 1370, y: 620 },
  { userId: users[2].user_id, user: users[2], color: '#f97316', x: 2550, y: 260 },
  { userId: users[5].user_id, user: users[5], color: '#eab308', x: 650, y: 820 },
];

export const MarketingScreenshotPage = () => {
  useEffect(() => {
    document.title = 'Launch board · Agor';
  }, []);

  const maps = useMemo(() => {
    const boardById = new Map<string, Board>([[boardId, board]]);
    const repoById = new Map<string, Repo>([[repoId, repo]]);
    const branchById = new Map<string, Branch>(
      branches.map((branch) => [branch.branch_id, branch])
    );
    const sessionById = new Map<string, Session>(
      sessions.map((session) => [session.session_id, session])
    );
    const sessionsByBranch = new Map<string, Session[]>();
    for (const session of sessions) {
      const next = sessionsByBranch.get(session.branch_id) ?? [];
      next.push(session);
      sessionsByBranch.set(session.branch_id, next);
    }
    const boardObjects = [...boardEntityObjects, ...cardObjects];
    const boardObjectById = new Map<string, BoardEntityObject>(
      boardObjects.map((object) => [object.object_id, object])
    );
    const boardObjectsByBoardId = new Map<string, BoardEntityObject[]>([[boardId, boardObjects]]);
    const cardById = new Map<string, CardWithType>(cards.map((card) => [card.card_id, card]));
    const userById = new Map<string, User>(users.map((user) => [user.user_id, user]));
    const commentById = new Map<string, BoardComment>(
      comments.map((comment) => [comment.comment_id, comment])
    );
    return {
      boardById,
      repoById,
      branchById,
      sessionById,
      sessionsByBranch,
      boardObjectById,
      boardObjectsByBoardId,
      cardById,
      userById,
      commentById,
    };
  }, []);

  // Seed the global store with the demo fixtures so SessionCanvas's selector
  // subscriptions resolve against them — the canvas reads entity state from the
  // store, not props. This standalone demo route owns the store for its lifetime.
  // Seeding runs in an effect (not during render) so the external singleton is
  // mutated as a commit side effect rather than mid-render.
  useEffect(() => {
    agorStore.setState({
      boardById: maps.boardById,
      repoById: maps.repoById,
      branchById: maps.branchById,
      sessionById: maps.sessionById,
      sessionsByBranch: maps.sessionsByBranch,
      boardObjectById: maps.boardObjectById,
      boardObjectsByBoardId: maps.boardObjectsByBoardId,
      cardById: maps.cardById,
      userById: maps.userById,
      commentById: maps.commentById,
      // AppHeader's GlobalSearch reads artifacts + MCP servers from the store;
      // pin them empty so a previously-populated workspace store can't leak its
      // entities into this standalone demo regardless of prior state.
      artifactById: new Map(),
      mcpServerById: new Map(),
    });
  }, [maps]);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#14b8a6',
          borderRadius: 12,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      }}
    >
      <AntdApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <Layout className="marketing-product-page" data-testid="marketing-screenshot-page">
            <AppHeader
              user={users[0]}
              presenceClient={null}
              currentUserId={users[0].user_id}
              staticActiveUsers={activeUsers}
              connected={true}
              connecting={false}
              currentBoardName={board.name}
              currentBoardIcon={board.icon}
              unreadCommentsCount={comments.length}
              eventStreamEnabled={true}
              hasUserMentions={true}
              currentBoardId={boardId}
            />
            <main className="marketing-product-canvas">
              <ReactFlowProvider>
                <SessionCanvas
                  board={board}
                  client={null}
                  branches={branches}
                  currentUserId={users[0].user_id}
                  selectedSessionId={null}
                  availableAgents={[]}
                  staticCursors={staticCursors}
                  staticCursorScale={1.3}
                  height="calc(100vh - 64px)"
                />
              </ReactFlowProvider>
            </main>
          </Layout>
        </ConnectionProvider>
      </AntdApp>
    </ConfigProvider>
  );
};

export default MarketingScreenshotPage;
