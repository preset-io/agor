import type { ActiveUser, Board, BoardID, User } from '@agor-live/client';
import {
  ApiOutlined,
  BranchesOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CodeOutlined,
  CommentOutlined,
  DeploymentUnitOutlined,
  ForkOutlined,
  GithubOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { Badge, ConfigProvider, Progress, Tag } from 'antd';
import { useEffect } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { BRAND, brandMarkHref } from '../branding/brand';
import { GlobalPresenceFacepile } from '../components/AppHeader/GlobalPresenceFacepile';
import {
  RemoteCursorLayer,
  type StaticRemoteCursor,
} from '../components/SessionCanvas/canvas/RemoteCursorLayer';
import './MarketingScreenshotPage.css';

type AgentStatus = 'running' | 'review' | 'done' | 'blocked';

interface DemoBranch {
  id: string;
  emoji: string;
  title: string;
  repo: string;
  zone: 'ship' | 'review' | 'assistants';
  x: number;
  y: number;
  accent: string;
  pr?: string;
  issue?: string;
  env?: string;
  sessions: Array<{
    agent: 'Claude' | 'Codex' | 'Gemini' | 'OpenCode';
    status: AgentStatus;
    label: string;
    progress: number;
  }>;
  notes: string[];
}

const DEMO_BOARD_ID = '019ee88d-demo-board' as BoardID;

const USERS = [
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

const DEMO_BOARD = {
  board_id: DEMO_BOARD_ID,
  name: 'Launch board',
  icon: '🚢',
} as Board;

const DEMO_BOARD_BY_ID = new Map<string, Board>([[DEMO_BOARD_ID, DEMO_BOARD]]);

const DEMO_ACTIVE_USERS: ActiveUser[] = USERS.map((user, index) => ({
  user,
  lastSeen: Date.now() - index * 1_000,
  boardId: DEMO_BOARD_ID,
  cursor: { x: 420 + index * 42, y: 180 + (index % 3) * 84 },
}));

const DEMO_CURSORS: StaticRemoteCursor[] = [
  { userId: USERS[0].user_id, user: USERS[0], color: '#8b5cf6', x: 445, y: 128 },
  { userId: USERS[1].user_id, user: USERS[1], color: '#06b6d4', x: 815, y: 478 },
  { userId: USERS[2].user_id, user: USERS[2], color: '#f97316', x: 1150, y: 270 },
  { userId: USERS[3].user_id, user: USERS[3], color: '#22c55e', x: 590, y: 728 },
  { userId: USERS[4].user_id, user: USERS[4], color: '#ec4899', x: 1020, y: 540 },
  { userId: USERS[5].user_id, user: USERS[5], color: '#eab308', x: 220, y: 418 },
  { userId: USERS[6].user_id, user: USERS[6], color: '#14b8a6', x: 1260, y: 620 },
  { userId: USERS[7].user_id, user: USERS[7], color: '#38bdf8', x: 350, y: 810 },
  { userId: USERS[8].user_id, user: USERS[8], color: '#f43f5e', x: 980, y: 188 },
];

const BRANCHES: DemoBranch[] = [
  {
    id: 'b1',
    emoji: '🚀',
    title: 'landing-hero-polish',
    repo: 'preset-io/agor',
    zone: 'ship',
    x: 112,
    y: 150,
    accent: '#14b8a6',
    pr: '#1248',
    issue: 'AG-214',
    env: '5174',
    sessions: [
      { agent: 'Claude', status: 'running', label: 'tightening hero copy', progress: 68 },
      { agent: 'Codex', status: 'done', label: 'responsive CSS pass', progress: 100 },
      { agent: 'Gemini', status: 'review', label: 'visual critique', progress: 84 },
    ],
    notes: ['Hero screenshot selected', 'CTA contrast updated', 'Needs final crop'],
  },
  {
    id: 'b2',
    emoji: '👥',
    title: 'multiplayer-presence',
    repo: 'preset-io/agor',
    zone: 'ship',
    x: 500,
    y: 202,
    accent: '#8b5cf6',
    pr: '#1251',
    issue: 'AG-220',
    env: '9182',
    sessions: [
      { agent: 'Codex', status: 'running', label: 'cursor layer fixture', progress: 73 },
      { agent: 'Claude', status: 'review', label: 'facepile polish', progress: 91 },
    ],
    notes: ['Live cursors look stable', 'Navbar facepile visible', 'Add tooltip labels'],
  },
  {
    id: 'b3',
    emoji: '🔐',
    title: 'rbac-terminal-safe-defaults',
    repo: 'preset-io/agor',
    zone: 'review',
    x: 930,
    y: 160,
    accent: '#f59e0b',
    pr: '#1254',
    issue: 'SEC-42',
    env: '3030',
    sessions: [
      { agent: 'Claude', status: 'running', label: 'sudoers audit', progress: 56 },
      { agent: 'OpenCode', status: 'blocked', label: 'waiting on ops note', progress: 42 },
    ],
    notes: ['Warning copy drafted', 'Docs link attached', 'Awaiting second review'],
  },
  {
    id: 'b4',
    emoji: '📊',
    title: 'usage-dashboard-artifact',
    repo: 'preset-io/agor',
    zone: 'assistants',
    x: 255,
    y: 560,
    accent: '#06b6d4',
    pr: '#1244',
    issue: 'AG-198',
    env: '7341',
    sessions: [
      { agent: 'Gemini', status: 'done', label: 'chart artifact published', progress: 100 },
      { agent: 'Codex', status: 'running', label: 'wire cost cards', progress: 61 },
    ],
    notes: ['Artifact pinned below', 'Synthetic data OK', 'Color tokens matched'],
  },
  {
    id: 'b5',
    emoji: '🤖',
    title: 'assistant-heartbeat',
    repo: 'preset-io/agor',
    zone: 'assistants',
    x: 690,
    y: 590,
    accent: '#22c55e',
    issue: 'BOT-17',
    env: '7777',
    sessions: [
      { agent: 'Claude', status: 'running', label: 'daily backlog scan', progress: 47 },
      { agent: 'Codex', status: 'done', label: 'triage report', progress: 100 },
      { agent: 'Gemini', status: 'review', label: 'summarize risks', progress: 80 },
    ],
    notes: ['Scheduled zone trigger', 'Slack digest ready', '3 branches spawned'],
  },
];

const statusMeta: Record<AgentStatus, { label: string; color: string; className: string }> = {
  running: { label: 'running', color: 'processing', className: 'is-running' },
  review: { label: 'needs review', color: 'warning', className: 'is-review' },
  done: { label: 'done', color: 'success', className: 'is-done' },
  blocked: { label: 'blocked', color: 'error', className: 'is-blocked' },
};

function BranchCard({ branch }: { branch: DemoBranch }) {
  const activeSessions = branch.sessions.filter((session) => session.status === 'running').length;

  return (
    <article
      className={`marketing-branch-card marketing-branch-card--${branch.zone}`}
      style={{ left: branch.x, top: branch.y, ['--accent' as string]: branch.accent }}
    >
      <div className="marketing-branch-card__glow" />
      <header className="marketing-branch-card__header">
        <div className="marketing-branch-card__title-row">
          <span className="marketing-branch-card__emoji">{branch.emoji}</span>
          <div>
            <h3>{branch.title}</h3>
            <div className="marketing-branch-card__repo">
              <GithubOutlined /> {branch.repo}
            </div>
          </div>
        </div>
        <Badge count={activeSessions} color={branch.accent} />
      </header>

      <div className="marketing-branch-card__meta">
        {branch.pr && <Tag color="cyan">PR {branch.pr}</Tag>}
        {branch.issue && <Tag color="purple">{branch.issue}</Tag>}
        {branch.env && <Tag color="green">env :{branch.env}</Tag>}
      </div>

      <div className="marketing-branch-card__sessions">
        {branch.sessions.map((session) => {
          const meta = statusMeta[session.status];
          return (
            <div
              className="marketing-session-row"
              key={`${branch.id}-${session.agent}-${session.label}`}
            >
              <div className={`marketing-agent-dot ${meta.className}`} />
              <div className="marketing-session-row__body">
                <div className="marketing-session-row__topline">
                  <strong>{session.agent}</strong>
                  <Tag color={meta.color}>{meta.label}</Tag>
                </div>
                <span>{session.label}</span>
                <Progress
                  percent={session.progress}
                  showInfo={false}
                  size="small"
                  strokeColor={branch.accent}
                  railColor="rgba(255,255,255,0.08)"
                />
              </div>
            </div>
          );
        })}
      </div>

      <ul className="marketing-branch-card__notes">
        {branch.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </article>
  );
}

function Zone({
  name,
  subtitle,
  x,
  y,
  w,
  h,
  color,
}: {
  name: string;
  subtitle: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}) {
  return (
    <section
      className="marketing-zone"
      style={{ left: x, top: y, width: w, height: h, ['--zone-color' as string]: color }}
    >
      <div className="marketing-zone__label">
        <strong>{name}</strong>
        <span>{subtitle}</span>
      </div>
    </section>
  );
}

function ArtifactCard() {
  return (
    <aside className="marketing-artifact-card">
      <div className="marketing-artifact-card__header">
        <div>
          <span className="marketing-eyebrow">Published artifact</span>
          <h3>Usage cockpit</h3>
        </div>
        <Tag color="cyan">live preview</Tag>
      </div>
      <div className="marketing-bars">
        {[68, 44, 82, 58, 92, 74, 48].map((height) => (
          <span key={`bar-${height}`} style={{ height: `${height}%` }} />
        ))}
      </div>
      <div className="marketing-artifact-card__stats">
        <div>
          <strong>$42.18</strong>
          <span>today</span>
        </div>
        <div>
          <strong>19</strong>
          <span>active runs</span>
        </div>
        <div>
          <strong>4.7m</strong>
          <span>tokens</span>
        </div>
      </div>
    </aside>
  );
}

function CommentPin() {
  return (
    <div className="marketing-comment-pin">
      <CommentOutlined />
      <div>
        <strong>Mina</strong> left a note on the review zone
      </div>
    </div>
  );
}

export const MarketingScreenshotPage = () => {
  useEffect(() => {
    document.title = 'Marketing screenshot board · Agor';
  }, []);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#14b8a6',
          borderRadius: 12,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      }}
    >
      <main className="marketing-screenshot-page" data-testid="marketing-screenshot-page">
        <header className="marketing-topbar">
          <div className="marketing-topbar__brand">
            <img src={brandMarkHref()} alt={BRAND.name} />
            <div>
              <strong>Agor</strong>
              <span>Team command center</span>
            </div>
          </div>

          <div className="marketing-board-switcher">
            <DeploymentUnitOutlined />
            <span>Launch board</span>
            <Tag color="cyan">Marketing screenshot</Tag>
          </div>

          <div className="marketing-topbar__right">
            <div className="marketing-presence-pill">
              <span className="marketing-presence-pill__pulse" />
              12 online
            </div>
            <GlobalPresenceFacepile
              client={null}
              currentBoardId={DEMO_BOARD_ID}
              users={USERS}
              currentUser={USERS[0]}
              boardById={DEMO_BOARD_BY_ID}
              staticActiveUsers={DEMO_ACTIVE_USERS}
              maxVisible={12}
            />
          </div>
        </header>

        <div className="marketing-stage-shell">
          <aside className="marketing-left-panel">
            <div className="marketing-panel-card marketing-panel-card--hero">
              <span className="marketing-eyebrow">All sessions</span>
              <h2>18 agent runs across 5 branches</h2>
              <p>
                Branches anchor the work: prompts, PRs, environments, comments, and artifacts all
                stay visible together.
              </p>
              <div className="marketing-panel-kpis">
                <span>
                  <ThunderboltFilled /> 7 running
                </span>
                <span>
                  <CheckCircleFilled /> 9 done
                </span>
                <span>
                  <ClockCircleOutlined /> 2 queued
                </span>
              </div>
            </div>
            <div className="marketing-panel-card">
              <span className="marketing-eyebrow">Zone trigger</span>
              <h3>Security review fan-out</h3>
              <p>
                Dropping a branch into Review spawns Claude + Codex with the team's audit prompt.
              </p>
            </div>
            <div className="marketing-panel-card marketing-terminal-card">
              <div>
                <CodeOutlined /> shared terminal
              </div>
              <code>$ pnpm -w agor session list</code>
              <code>✓ 7 running · 3 waiting · 19 done</code>
            </div>
          </aside>

          <ReactFlowProvider>
            <section className="marketing-board-canvas" aria-label="Demo Agor board screenshot">
              <div className="marketing-board-grid" />
              <Zone
                name="🚢 Ship this week"
                subtitle="polish + landing-page ready"
                x={72}
                y={92}
                w={770}
                h={390}
                color="#14b8a6"
              />
              <Zone
                name="🔎 Review lane"
                subtitle="security, docs, and handoffs"
                x={878}
                y={96}
                w={398}
                h={362}
                color="#f59e0b"
              />
              <Zone
                name="🤖 Assistants"
                subtitle="scheduled agents + artifacts"
                x={166}
                y={518}
                w={975}
                h={352}
                color="#8b5cf6"
              />

              {BRANCHES.map((branch) => (
                <BranchCard branch={branch} key={branch.id} />
              ))}

              <ArtifactCard />
              <CommentPin />

              <div className="marketing-connection marketing-connection--one" />
              <div className="marketing-connection marketing-connection--two" />
              <div className="marketing-connection marketing-connection--three" />

              <RemoteCursorLayer
                client={null}
                boardId={DEMO_BOARD_ID}
                users={USERS}
                staticCursors={DEMO_CURSORS}
              />
            </section>
          </ReactFlowProvider>

          <aside className="marketing-right-rail">
            <div className="marketing-event-card">
              <span className="marketing-eyebrow">Live event stream</span>
              <ul>
                <li>
                  <ForkOutlined /> Codex forked <strong>presence fixture</strong>
                </li>
                <li>
                  <BranchesOutlined /> Claude spawned a review child session
                </li>
                <li>
                  <ApiOutlined /> Artifact published to board
                </li>
                <li>
                  <CommentOutlined /> Mina mentioned Max in Review
                </li>
              </ul>
            </div>
          </aside>
        </div>
      </main>
    </ConfigProvider>
  );
};

export default MarketingScreenshotPage;
