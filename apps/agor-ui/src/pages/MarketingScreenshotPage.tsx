import type {
  ActiveUser,
  Board,
  BoardComment,
  BoardEntityObject,
  BoardID,
  Branch,
  BranchID,
  CardWithType,
  MCPServer,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { SessionStatus } from '@agor-live/client';
import { App as AntdApp, ConfigProvider, Layout, theme } from 'antd';
import { useEffect, useMemo } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { AppHeader } from '../components/AppHeader';
import { SessionCanvas } from '../components/SessionCanvas';
import type { StaticRemoteCursor } from '../components/SessionCanvas/canvas/RemoteCursorLayer';
import { ConnectionProvider } from '../contexts/ConnectionContext';
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
  description: 'Marketing screenshot staging board built from product canvas components.',
  icon: '🚢',
  color: '#14b8a6',
  access_mode: 'shared',
  created_at: now,
  last_updated: now,
  created_by: users[0].user_id,
  archived: false,
  url: '/demo/marketing-screenshots',
  background_color:
    'radial-gradient(circle at 18% 10%, rgba(20,184,166,0.18), transparent 28%), radial-gradient(circle at 80% 20%, rgba(139,92,246,0.16), transparent 32%), linear-gradient(135deg, #07111d 0%, #090d1a 52%, #0d1020 100%)',
  objects: {
    'zone-ship': {
      type: 'zone',
      x: 80,
      y: 70,
      width: 820,
      height: 430,
      label: '🚢 Ship this week',
      borderColor: '#14b8a6',
      backgroundColor: 'rgba(20,184,166,0.10)',
      locked: true,
      trigger: {
        behavior: 'show_picker',
        agent: 'claude-code',
        template: 'Polish {{branch.name}} for the landing-page screenshot crop.',
      },
    },
    'zone-review': {
      type: 'zone',
      x: 940,
      y: 80,
      width: 520,
      height: 420,
      label: '🔎 Review lane',
      borderColor: '#f59e0b',
      backgroundColor: 'rgba(245,158,11,0.10)',
      locked: true,
      trigger: {
        behavior: 'always_new',
        agent: 'codex',
        template: 'Run a security/docs pass on {{branch.name}} and leave concise review notes.',
      },
    },
    'zone-assistants': {
      type: 'zone',
      x: 210,
      y: 560,
      width: 1120,
      height: 390,
      label: '🤖 Assistants + artifacts',
      borderColor: '#8b5cf6',
      backgroundColor: 'rgba(139,92,246,0.11)',
      locked: true,
      trigger: {
        behavior: 'show_picker',
        agent: 'gemini',
        template: 'Turn this branch into an artifact or status summary for the board.',
      },
    },
    'note-launch': {
      type: 'markdown',
      x: -290,
      y: 90,
      width: 320,
      content:
        '### Screenshot staging\n\nReal board, zone, branch, card, and markdown components. Only **presence** and **remote cursors** are fixed fixtures for capture.',
    },
    'note-terminal': {
      type: 'markdown',
      x: -290,
      y: 350,
      width: 320,
      content: '```bash\npnpm -w agor session list\n✓ 7 running · 3 waiting · 19 done\n```',
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
} as Repo;

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
  sessions: ReadonlyArray<readonly [string, string, string, string]>;
}

const branchFixtures = [
  {
    id: '019ee88d-demo-branch-0000-000000000101',
    name: 'landing-hero-polish',
    ref: 'landing-hero-polish',
    zoneId: 'zone-ship',
    position: { x: 50, y: 66 },
    issue: 'https://github.com/preset-io/agor/issues/214',
    pr: 'https://github.com/preset-io/agor/pull/1248',
    notes:
      '**Goal:** make the homepage crop feel alive. Hero copy tightened, CTA contrast updated, final crop pending.',
    env: { status: 'running', url: 'http://localhost:5174' },
    sessions: [
      ['Claude', 'claude-code', SessionStatus.RUNNING, 'tightening hero copy'],
      ['Codex', 'codex', SessionStatus.COMPLETED, 'responsive CSS pass'],
      ['Gemini', 'gemini', SessionStatus.RUNNING, 'visual critique'],
    ],
  },
  {
    id: '019ee88d-demo-branch-0000-000000000102',
    name: 'multiplayer-presence',
    ref: 'multiplayer-presence',
    zoneId: 'zone-ship',
    position: { x: 470, y: 118 },
    issue: 'https://linear.app/agor/issue/AG-220',
    pr: 'https://github.com/preset-io/agor/pull/1251',
    notes:
      'Static fixture drives the live facepile/cursor components for screenshot reliability. Product presence behavior remains unchanged.',
    env: { status: 'running', url: 'http://localhost:9182' },
    sessions: [
      ['Codex', 'codex', SessionStatus.RUNNING, 'cursor layer fixture'],
      ['Claude', 'claude-code', SessionStatus.RUNNING, 'facepile polish'],
    ],
  },
  {
    id: '019ee88d-demo-branch-0000-000000000103',
    name: 'rbac-terminal-safe-defaults',
    ref: 'rbac-terminal-safe-defaults',
    zoneId: 'zone-review',
    position: { x: 44, y: 78 },
    issue: 'https://github.com/preset-io/agor/issues/42',
    pr: 'https://github.com/preset-io/agor/pull/1254',
    notes:
      'Review lane fan-out: sudoers warning copy drafted, docs link attached, awaiting a second pass.',
    env: { status: 'starting', url: 'http://localhost:3030' },
    sessions: [
      ['Claude', 'claude-code', SessionStatus.RUNNING, 'sudoers audit'],
      ['OpenCode', 'opencode', SessionStatus.AWAITING_PERMISSION, 'waiting on ops note'],
    ],
  },
  {
    id: '019ee88d-demo-branch-0000-000000000104',
    name: 'usage-dashboard-artifact',
    ref: 'usage-dashboard-artifact',
    zoneId: 'zone-assistants',
    position: { x: 60, y: 72 },
    issue: 'https://linear.app/agor/issue/AG-198',
    pr: 'https://github.com/preset-io/agor/pull/1244',
    notes:
      'Agent-authored dashboard card is pinned below the branch. Synthetic data is OK for screenshot staging.',
    env: { status: 'running', url: 'http://localhost:7341' },
    sessions: [
      ['Gemini', 'gemini', SessionStatus.COMPLETED, 'chart artifact published'],
      ['Codex', 'codex', SessionStatus.RUNNING, 'wire cost cards'],
    ],
  },
  {
    id: '019ee88d-demo-branch-0000-000000000105',
    name: 'assistant-heartbeat',
    ref: 'assistant-heartbeat',
    zoneId: 'zone-assistants',
    position: { x: 545, y: 98 },
    issue: 'https://linear.app/agor/issue/BOT-17',
    notes:
      'Scheduled assistant heartbeat: daily backlog scan, Slack digest ready, three branches spawned for follow-up.',
    env: { status: 'stopped', url: 'http://localhost:7777' },
    sessions: [
      ['Claude', 'claude-code', SessionStatus.RUNNING, 'daily backlog scan'],
      ['Codex', 'codex', SessionStatus.COMPLETED, 'triage report'],
      ['Gemini', 'gemini', SessionStatus.RUNNING, 'summarize risks'],
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
      pull_request_url: fixture.pr,
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
      url: `/ui/w/${fixture.id.slice(0, 8)}`,
    }) as Branch
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
    ([title, tool, status, description], sessionIndex) =>
      ({
        session_id: `${fixture.id.slice(0, 28)}${sessionIndex + 1}`,
        agentic_tool: tool,
        status,
        created_at: now,
        last_updated: now,
        created_by: users[(branchIndex + sessionIndex) % users.length].user_id,
        unix_username: null,
        branch_id: fixture.id as BranchID,
        branch_board_id: boardId,
        url: `/ui/s/${fixture.id.slice(0, 8)}${sessionIndex}`,
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
        ready_for_prompt: status === SessionStatus.COMPLETED && sessionIndex === 0,
        archived: false,
      }) as Session
  )
);

const cards: CardWithType[] = [
  {
    card_id: '019ee88d-demo-card-0000-000000000201',
    board_id: boardId,
    title: 'Landing page screenshot checklist',
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
    note: 'Published by Gemini, wired by Codex, ready for docs-site screenshot folder.',
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
];

const cardObjects: BoardEntityObject[] = [
  {
    object_id: 'board-object-card-201',
    board_id: boardId,
    card_id: cards[0].card_id,
    entity_type: 'card',
    position: { x: 900, y: 620 },
    zone_id: 'zone-assistants',
    created_at: now,
  },
  {
    object_id: 'board-object-card-202',
    board_id: boardId,
    card_id: cards[1].card_id,
    entity_type: 'card',
    position: { x: 60, y: 255 },
    zone_id: 'zone-assistants',
    created_at: now,
  },
  {
    object_id: 'board-object-card-203',
    board_id: boardId,
    card_id: cards[2].card_id,
    entity_type: 'card',
    position: { x: 110, y: 285 },
    zone_id: 'zone-review',
    created_at: now,
  },
];

const comments: BoardComment[] = [
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
        offset_x: 410,
        offset_y: 44,
      },
    },
    mentions: [users[0].user_id],
    created_at: new Date(now),
  },
];

const activeUsers: ActiveUser[] = users.map((user, index) => ({
  user,
  lastSeen: Date.now() - index * 1_000,
  boardId,
  cursor: { x: 420 + index * 42, y: 180 + (index % 3) * 84 },
}));

const staticCursors: StaticRemoteCursor[] = [
  { userId: users[0].user_id, user: users[0], color: '#8b5cf6', x: 760, y: 190 },
  { userId: users[1].user_id, user: users[1], color: '#06b6d4', x: 1240, y: 475 },
  { userId: users[2].user_id, user: users[2], color: '#f97316', x: 1380, y: 285 },
  { userId: users[3].user_id, user: users[3], color: '#22c55e', x: 610, y: 760 },
  { userId: users[4].user_id, user: users[4], color: '#ec4899', x: 1040, y: 600 },
  { userId: users[5].user_id, user: users[5], color: '#eab308', x: 225, y: 430 },
  { userId: users[6].user_id, user: users[6], color: '#14b8a6', x: 1460, y: 710 },
  { userId: users[7].user_id, user: users[7], color: '#38bdf8', x: 420, y: 890 },
];

export const MarketingScreenshotPage = () => {
  useEffect(() => {
    document.title = 'Marketing screenshot board · Agor';
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
              presenceUsers={users}
              currentUserId={users[0].user_id}
              staticActiveUsers={activeUsers}
              connected={true}
              connecting={false}
              currentBoardName={board.name}
              currentBoardIcon={board.icon}
              unreadCommentsCount={comments.length}
              eventStreamEnabled={true}
              hasUserMentions={true}
              boards={[board]}
              currentBoardId={boardId}
              branchById={maps.branchById}
              boardById={maps.boardById}
              recentBoards={[]}
              instanceLabel="Marketing screenshot"
              sessionById={maps.sessionById}
              artifactById={new Map()}
              mcpServerById={new Map<string, MCPServer>()}
            />
            <main className="marketing-product-canvas">
              <ReactFlowProvider>
                <SessionCanvas
                  board={board}
                  client={null}
                  sessionById={maps.sessionById}
                  sessionsByBranch={maps.sessionsByBranch}
                  userById={maps.userById}
                  repoById={maps.repoById}
                  branches={branches}
                  branchById={maps.branchById}
                  boardObjectById={maps.boardObjectById}
                  boardObjectsByBoardId={maps.boardObjectsByBoardId}
                  commentById={maps.commentById}
                  cardById={maps.cardById}
                  currentUserId={users[0].user_id}
                  selectedSessionId={sessions[0]?.session_id ?? null}
                  availableAgents={[]}
                  mcpServerById={new Map()}
                  sessionMcpServerIds={new Map()}
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
