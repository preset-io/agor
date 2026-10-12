import type { LandingDetail } from './types';

export const teammatesDetails: LandingDetail[] = [
  {
    id: 'shared-ownership',
    navLabel: 'Shared ownership',
    eyebrow: 'Owned by the team',
    title: 'A teammate the whole {team} can [own]',
    body: [
      'The PR reviewer or reporting bot your team depends on shouldn’t live in one person’s private setup. In Agor, a teammate lives on a shared branch with its own board, so its instructions, memory, and history are there for the team to see.',
      'Board and branch permissions decide who can see it, work with it, or manage it, and Knowledge namespaces have owners too. When someone is out, a colleague can pick up the work, read what happened, and keep improving it.',
    ],
    points: [
      {
        title: 'Visible by default',
        body: 'Sessions keep the messages, tool calls, and model used, so anyone with access can see what the teammate did.',
      },
      {
        title: 'Roles, not favors',
        body: 'Viewer, Collaborator, and Manager roles on branches, and owners and admins on Knowledge namespaces.',
      },
      {
        title: 'Improve it together',
        body: 'Corrections go into its memory and runbooks, so what one person teaches carries forward for everyone.',
      },
    ],
    links: [
      { label: 'Why teams need modeled teammates', href: '/blog/claude-tag-vs-agor-assistants' },
      { label: 'Permissions and isolation', href: '/guide/multiplayer-unix-isolation' },
    ],
  },
  {
    id: 'memory',
    navLabel: 'Memory & knowledge',
    eyebrow: 'Stop starting over',
    title: 'Pick up where you [left off]',
    body: [
      'Good context shouldn’t stay buried in an old conversation. A teammate keeps plain-markdown memory on its own branch: who it is, what it knows about the people it works with, and a daily journal of decisions and learnings. Each new session starts by reading it.',
      'For context the whole team needs, Agor Knowledge gives people and teammates one shared place for runbooks, decisions, and prompts. Memory is only as good as what gets written down, so your team can read it, edit it, and correct it.',
    ],
    points: [
      {
        title: 'Identity and a daily journal',
        body: 'SOUL.md, IDENTITY.md, USER.md, and dated memory files, versioned in git alongside the teammate.',
      },
      {
        title: 'Shared Knowledge',
        body: 'Markdown documents in namespaces, with version history, links between pages, and text search. Semantic search is available when an admin turns on embeddings.',
      },
    ],
    media: {
      type: 'image',
      src: '/images/knowledge-hero.png',
      alt: 'Agor Knowledge graph view connecting documents across a product and strategy space',
    },
    links: [
      { label: 'Knowledge', href: '/guide/knowledge' },
      { label: 'How teammates remember', href: '/guide/teammates' },
      { label: 'How Hodor keeps its memory', href: '/blog/meet-hodor' },
    ],
  },
  {
    id: 'channels',
    navLabel: 'In your channels',
    eyebrow: 'Where your team works',
    title: 'Bring it where your team [already talks]',
    body: [
      'Not everyone needs to live on the board. Mention a teammate in Slack or Discord, or tag it on a GitHub PR or Shortcut story, and Agor starts a session on the right branch and replies where you asked. Microsoft Teams is coming soon to Agor Cloud.',
      'When a sender is matched to an Agor user, the session runs as that person, with their access and their name on the record. Each channel has its own model, tools, and approval rules.',
    ],
    points: [
      {
        title: 'Mention to start',
        body: 'In Slack and Discord channels, a teammate only answers when someone mentions it.',
      },
      {
        title: 'You decide how much rope',
        body: 'Keep a person approving each tool call from the linked Agor session in one channel, and let well-understood work run on its own in another.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/marketing/agor-marketing-slack-thread.png',
      alt: 'Slack thread where a person mentions an Agor teammate, which starts a session and replies with a link to it',
    },
    links: [
      { label: 'Message gateway and its security notes', href: '/guide/message-gateway' },
      { label: 'Meet Blake, our deal desk agent', href: '/blog/meet-blake' },
    ],
  },
  {
    id: 'schedules',
    navLabel: 'Schedules',
    eyebrow: 'Recurring work',
    title: 'Standups, digests, and audits on a [schedule]',
    body: [
      'Some work should happen every morning whether or not anyone remembers to ask. Attach a cron schedule to a teammate’s branch, and each run starts a fresh session with the branch and board context it needs.',
      'A teammate’s heartbeat is a schedule that reads HEARTBEAT.md: check in-progress work, triage what’s new, write the day’s notes to memory. Every run leaves a full transcript your team can review.',
    ],
    points: [
      {
        title: 'Any cadence',
        body: 'From every few minutes to once a day, set with a visual cron builder. Schedules run in UTC.',
      },
      {
        title: 'No pile-ups',
        body: 'Runs are deduplicated, and after downtime only the most recent missed run fires.',
      },
      {
        title: 'Pick the agent',
        body: 'Choose Claude Code, Codex, Gemini, or another supported agent for each schedule.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/scheduler-modal.png',
      alt: 'Configure Schedule modal with a daily cron, an agent picker, and a prompt to read HEARTBEAT.md and run a heartbeat',
    },
    links: [
      { label: 'Scheduler', href: '/guide/scheduler' },
      {
        label: 'Wendy’s daily heartbeat',
        href: '/blog/meet-wendy-preset-ai-competitive-intelligence-analyst',
      },
    ],
  },
  {
    id: 'skills-and-mcp',
    navLabel: 'Skills & tools',
    eyebrow: 'Teach skills, connect tools',
    title: 'Teach it the {way} your team [works]',
    body: [
      'Package the steps your team repeats as skills: a release check, a review checklist, a weekly report. Skills live with the teammate, so the method is written down instead of living in one person’s head.',
      'Then connect the systems it needs. Skills and MCP servers let a teammate work with tools like Slack, GitHub, Linear, and Datadog, and Agor’s own MCP server lets it create branches, spawn sessions, and organize boards.',
    ],
    points: [
      {
        title: 'Skills',
        body: 'Repeatable methods for SaaS tools, command-line tools, and APIs, defined alongside the teammate.',
      },
      {
        title: 'MCP Catalog',
        body: 'Reviewed remote servers you connect once, with OAuth or a key, then attach to sessions.',
      },
      {
        title: 'Agor’s own MCP',
        body: 'Through Agor’s built-in MCP server, a teammate works with the same API you do: spawning sessions, moving branches, scheduling runs, all within your permissions.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/onboarding-mcp-tools.png',
      alt: 'Onboarding step Connect your tools via MCP, recommending Slack, HubSpot, Amplitude, and Figma',
    },
    links: [
      { label: 'MCP servers and Catalog', href: '/guide/mcp-servers' },
      { label: 'Agor MCP server', href: '/guide/internal-mcp' },
    ],
  },
  {
    id: 'onboarding',
    navLabel: 'Teach by talking',
    eyebrow: 'Teach it by talking',
    title: 'Onboard it like a new [teammate]',
    body: [
      'You don’t need a perfect system prompt on day one. A new teammate starts with a guided first conversation that works toward a real outcome for you, while it learns your goals, your context, and how you like to work.',
      'From there, teaching is ordinary conversation. Correct a weak answer, point it at the right doc, or tighten how it reports, and it keeps what it learns in its memory for next time.',
    ],
    points: [
      {
        title: 'Start from a persona',
        body: 'Pick a persona from the gallery or start blank, then give your teammate a name and its own board.',
      },
      {
        title: 'Onboarding with a goal',
        body: 'ONBOARDING.md steers early sessions toward something useful, not a configuration checklist.',
      },
      {
        title: 'Keep correcting',
        body: 'Review its output, correct it, and fold the fix into its runbook. That loop is how it gets better.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/onboarding-name-teammate.png',
      alt: 'Onboarding step titled Name your AI teammate, naming a teammate ReleaseBot, which gets its own board',
    },
    links: [
      { label: 'Raising your first teammate', href: '/guide/first-teammate' },
      { label: 'Raise a team helper agent', href: '/blog/raise-team-helper-agent' },
    ],
  },
  {
    id: 'identity',
    navLabel: 'Identity & boundaries',
    eyebrow: 'Identity and boundaries',
    title: 'A clear [job] and clear {limits}',
    body: [
      'A useful teammate fits in one sentence: it helps this team handle this kind of work across these systems. Its identity files hold that purpose, along with its voice and the principles it works by. Those files come from agor-teammate, the public framework every Agor teammate is built on, which borrows its core ideas from OpenClaw.',
      'People stay in charge of scope. Decide what it can do read-only, what it drafts for review, and when it should stop and ask. Start with a tight loop, and widen its autonomy as it earns trust.',
    ],
    points: [
      {
        title: 'Purpose and voice',
        body: 'IDENTITY.md and SOUL.md describe who it is, who it serves, and how it communicates.',
      },
      {
        title: 'Approval boundaries',
        body: 'Permission modes decide whether a person approves each tool call or the teammate works on its own.',
      },
      {
        title: 'Access that fits the role',
        body: 'Scope its tools and Knowledge to the job, not to everything the company has.',
      },
    ],
    links: [
      { label: 'Agent modeling 101', href: '/blog/agent-modeling-101' },
      { label: 'The agor-teammate framework', href: 'https://github.com/preset-io/agor-teammate' },
      { label: 'Agor and OpenClaw', href: '/blog/openclaw' },
    ],
  },
];
