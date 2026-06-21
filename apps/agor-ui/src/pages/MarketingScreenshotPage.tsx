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
import { Avatar, Badge, ConfigProvider, Progress, Tag, Tooltip } from 'antd';
import { useEffect } from 'react';
import { BRAND, brandMarkHref } from '../branding/brand';
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

const USERS = [
  { name: 'Max', emoji: '🧑‍🚀', color: '#8b5cf6' },
  { name: 'Ari', emoji: '🧠', color: '#06b6d4' },
  { name: 'Mina', emoji: '🎨', color: '#f97316' },
  { name: 'Devon', emoji: '🛠️', color: '#22c55e' },
  { name: 'Kai', emoji: '🚢', color: '#ec4899' },
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

function Cursor({
  user,
  x,
  y,
  rotate = 0,
}: {
  user: (typeof USERS)[number];
  x: number;
  y: number;
  rotate?: number;
}) {
  return (
    <div
      className="marketing-cursor"
      style={{ left: x, top: y, ['--cursor-color' as string]: user.color }}
    >
      <svg width="28" height="28" viewBox="0 0 24 24" style={{ rotate: `${rotate}deg` }}>
        <title>{`${user.name} cursor`}</title>
        <path d="M5.5 3.5L18.5 12L11 14L8 20.5L5.5 3.5Z" />
      </svg>
      <div className="marketing-cursor__label">
        <span>{user.emoji}</span>
        {user.name}
      </div>
    </div>
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
              <span className="marketing-presence-pill__pulse" />5 online
            </div>
            <Avatar.Group max={{ count: 4 }}>
              {USERS.map((user) => (
                <Tooltip title={user.name} key={user.name}>
                  <Avatar style={{ background: user.color }}>{user.emoji}</Avatar>
                </Tooltip>
              ))}
            </Avatar.Group>
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

            <Cursor user={USERS[0]} x={445} y={128} rotate={-8} />
            <Cursor user={USERS[1]} x={815} y={478} rotate={6} />
            <Cursor user={USERS[2]} x={1150} y={270} rotate={-4} />
            <Cursor user={USERS[3]} x={590} y={728} rotate={8} />
            <Cursor user={USERS[4]} x={1020} y={540} rotate={-10} />
          </section>

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
