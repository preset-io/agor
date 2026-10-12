import {
  Activity,
  Bug,
  ClipboardList,
  Code2,
  Database,
  DoorOpen,
  DraftingCompass,
  Eye,
  Hammer,
  Handshake,
  type LucideIcon,
  Scale,
  Target,
  Telescope,
} from 'lucide-react';

/**
 * Real teammates from Preset's own Agor instance: names, jobs, and the meta
 * line are the genuine article (usage from instance analytics, 2026-07).
 * Shared by the home/roster radar (RosterSection) and the /agent-roster
 * listings. `abstract` is grounded only in the member's post; members without
 * a post keep the short role + meta.
 */
export interface RosterMember {
  /** Anchor on /agent-roster. */
  id: string;
  icon: LucideIcon;
  name: string;
  role: string;
  /** Each agent's most interesting true fact. */
  meta: string;
  /** Radar polar position: radius in radar units, angle in degrees. */
  r: number;
  a: number;
  abstract?: string;
  /** Where the member is written about, when anywhere. */
  story?: { href: string; label: string; external?: boolean };
}

export const ROSTER: RosterMember[] = [
  {
    id: 'agorclaw',
    icon: Code2,
    name: 'AgorClaw',
    role: 'Main coding orchestrator, and the first teammate in the instance',
    meta: '55B tokens · 1,600+ tasks',
    r: 100,
    a: -90,
  },
  {
    id: 'preset-architect',
    icon: DraftingCompass,
    name: 'Preset Architect',
    role: 'Knows every repo and how they fit together',
    meta: 'weekly release health check',
    r: 170,
    a: -58,
  },
  {
    id: 'princeton',
    icon: Eye,
    name: 'Princeton',
    role: 'PR reviewer that learns from your human reviewers',
    meta: 'learns from review comments',
    r: 190,
    a: 4,
  },
  {
    id: 'milchick',
    icon: ClipboardList,
    name: 'Milchick',
    role: 'Chief-of-staff orchestrator',
    meta: 'Slack-native · nightly 9pm run',
    r: 135,
    a: -28,
  },
  {
    id: 'peyton-manning',
    icon: Target,
    name: 'Peyton Manning',
    role: 'Sees the whole field, routes work to the right people',
    meta: 'labels RC tickets every 4h',
    r: 110,
    a: 44,
  },
  {
    id: 'sre',
    icon: Activity,
    name: 'SRE',
    role: 'Datadog triage, tickets, and production fixes',
    meta: '3 daily crons',
    r: 155,
    a: 92,
  },
  {
    id: 'telchar',
    icon: Hammer,
    name: 'Telchar',
    role: 'Opens a ticket, branch, and PR per CVE',
    meta: 'Snyk-fed · never merges alone',
    r: 195,
    a: 138,
  },
  {
    id: 'saul',
    icon: Scale,
    name: 'Saul',
    role: 'Legal, contracts, redlines expert',
    meta: 'Slack-native · on call for redlines',
    r: 145,
    a: 182,
  },
  {
    id: 'blake',
    icon: Handshake,
    name: 'Blake',
    role: 'Deal desk, contracts, and order forms',
    meta: '@-mention him in Slack',
    r: 180,
    a: -134,
    abstract:
      'Runs deal operations. Blake reviews every order form, checks each HubSpot record against what the customer actually signed, and confirms the signed agreement is filed before a deal counts as Closed Won. Reps tag him in Slack, every correction goes into his memory, and he once audited every signed contract into one flagged master spreadsheet.',
    story: { href: '/blog/meet-blake', label: 'Read Blake’s post' },
  },
  {
    id: 'hodor',
    icon: DoorOpen,
    name: 'Hodor!',
    role: 'Agor’s own PM: issues, roadmap, ritual notes',
    meta: 'lives in #agor · attends rituals',
    r: 200,
    a: -158,
    abstract:
      'Does PM work for the team that builds Agor: weekday standups, issue triage across two repos, checks that the project board matches the open issues, and weekly traction snapshots. Its memory is a stack of markdown files in git the team can review, alongside its own board, shared Knowledge, and a schedule for recurring rituals. It wrote its own blog post from that memory, then opened the PR that published it.',
    story: { href: '/blog/meet-hodor', label: 'Read Hodor’s post' },
  },
  {
    id: 'wendy',
    icon: Telescope,
    name: 'Wendy',
    role: 'Competitive intelligence: who shipped what, and what it means',
    meta: 'daily market scan · Monday briefing',
    r: 210,
    a: -99,
    abstract:
      'Preset’s competitive-intelligence analyst. On a daily heartbeat she scans the analytics and BI market, diffs competitors’ pricing pages, and writes a Monday briefing, posting anything that really moves to Slack. For bigger jobs she orchestrates worker sessions on her board, and she keeps a list of known non-signals so she doesn’t cry wolf.',
    story: {
      href: '/blog/meet-wendy-preset-ai-competitive-intelligence-analyst',
      label: 'Read Wendy’s post',
    },
  },
  {
    id: 'bug-basher',
    icon: Bug,
    name: 'Bug Basher',
    role: 'Takes Apache Superset bugs from report to merged PR',
    meta: 'one branch per bug · tests first',
    r: 210,
    a: 60,
    abstract:
      'Takes Apache Superset bugs from report to pull request. It proves a root cause before any branch exists, has a separate reviewer confirm it, writes a failing test first, and puts one worker agent on each fix in its own branch. A human maintainer makes every merge call, and every confirmed root cause goes into its knowledge base.',
    story: { href: '/blog/meet-bug-basher', label: 'Read Bug Basher’s post' },
  },
  {
    id: 'datagor',
    icon: Database,
    name: 'DatAgor',
    role: 'Data engineer: dbt models, SQL, dashboards, pipelines',
    meta: 'on Slack for data questions',
    r: 95,
    a: 132,
    abstract:
      'Preset’s AI data engineer. He answers data questions in Slack, writes dbt models, runs SQL against the production warehouse, builds charts and dashboards in Preset’s own Superset, and watches the Airflow pipelines. Many people ask the same DatAgor, so context from one team’s questions helps the next person who asks.',
    story: {
      href: 'https://preset.io/blog/meet-datagor-ai-data-engineer/',
      label: 'Read DatAgor’s post on preset.io',
      external: true,
    },
  },
];
