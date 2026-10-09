import type { LandingDetail } from './types';

export const commandCenterDetails: LandingDetail[] = [
  {
    id: 'parallel-agents',
    navLabel: 'Parallel agents',
    eyebrow: 'Run many at once',
    title: 'Fan out the work, then [review it together]',
    body: [
      'Split a job across several agents and watch each result come back to the parent. Have one agent do the work and a different one review it, whether that is a code change, a contract redline, or a sales deck, so the reviewer is not defending its own choices.',
      'Because every child is its own visible session, the review is something your team can open, question, and discuss, not a summary you have to take on faith.',
    ],
    points: [
      {
        title: 'Parallel test generation',
        body: 'One parent spawns a child per file and collects the callbacks as they land.',
      },
      {
        title: 'Cross-agent code review',
        body: 'A second agent reads the change with fresh eyes and reports findings back with file and line.',
      },
      {
        title: 'Research and collateral in parallel',
        body: 'One child per competitor, account, or draft, each filing its findings to Knowledge, compared side by side on the board.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/parallel-board-5-sessions.png',
      alt: 'Branch card with a Claude Code parent session and five Codex child sessions writing unit tests in parallel',
    },
    links: [
      { label: 'Real orchestration patterns', href: '/guide/sessions' },
      {
        label: 'Meet Wendy, who fans out research',
        href: '/blog/meet-wendy-preset-ai-competitive-intelligence-analyst',
      },
    ],
  },
  {
    id: 'zones-and-prompts',
    navLabel: 'Zones & prompts',
    eyebrow: 'Organize the work',
    title: 'Give every agent a [place], and every step a {prompt}',
    body: [
      'More agents means more coordination: which one is blocked, which one needs you, which review never started. On an Agor board every branch has a spot, so the state of the work is something you can see at a glance instead of reconstruct.',
      'Zones turn that layout into a workflow. Draw a "Code review", "Contract review", or "Weekly digest" zone once, give it a templated prompt, and dropping a branch in fills in its details, like the issue, PR, or environment, and sends it to an agent. Everyone working on the board uses the same process.',
    ],
    points: [
      {
        title: 'Templated prompts',
        body: 'Handlebars templates pull in the branch, board, repo, and environment, so nobody copies ticket links by hand.',
      },
      {
        title: 'Prompt, fork, or spawn',
        body: 'Choose a session when you drop a branch, or have the zone start a fresh one automatically.',
      },
      {
        title: 'Shared by default',
        body: 'Zones live on the board, so the workflow you set up is the one your colleagues use.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/zone-trigger.png',
      alt: 'Zone trigger dialog for a Codex review zone, with options to reuse a session, choose prompt, fork, or spawn, and an editable templated prompt',
    },
    links: [
      { label: 'Boards & zones', href: '/guide/boards' },
      { label: 'See Bug Basher’s bug pipeline', href: '/blog/meet-bug-basher' },
    ],
  },
  {
    id: 'session-trees',
    navLabel: 'Session trees',
    eyebrow: 'Follow the thread',
    title: 'Conversations that {branch} instead of scrolling away',
    body: [
      'A terminal forgets. In Agor every session is a conversation you can come back to, and it can grow a tree: fork to try an alternative with the same context, spawn a child with a fresh context for a focused job, or ask a quick side question without interrupting the main thread.',
      'The tree sits on the branch card, so you and anyone you bring in can see how a piece of work unfolded and pick up any part of it.',
    ],
    points: [
      {
        title: 'Spawn with callbacks',
        body: 'Children report back when they finish, and the parent stays responsive while they run.',
      },
      {
        title: 'Mix agents',
        body: 'Spawn a Codex child from a Claude session, or hand a subtask to Gemini or OpenCode.',
      },
      {
        title: 'Nothing disappears',
        body: 'Finished children stay in the tree, ready for a follow-up prompt.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/security-review-fanout.png',
      alt: 'Branch card showing a coordinator session that spawned eight parallel security-review sessions in a tree',
    },
    links: [{ label: 'Sessions & trees', href: '/guide/sessions' }],
  },
  {
    id: 'knowledge',
    navLabel: 'Knowledge',
    eyebrow: 'Keep context close',
    title: 'One place for the context your {agents} keep needing',
    body: [
      'Useful context is scattered across repos, docs, DMs, and old conversations, so agents answer without it and people explain the same thing twice. Agor Knowledge gives your team and its agents a default place to file what matters: runbooks, decisions, reusable prompts, and teammate memory.',
      'Agents in Agor can already search, read, and write it through the built-in MCP server, with no extra setup. What one session learns, the next one can find.',
    ],
    points: [
      {
        title: 'Markdown with history',
        body: 'Every update creates a new version, with diagrams, code, and tables rendered richly.',
      },
      {
        title: 'Search that grows with you',
        body: 'Text search out of the box, with optional semantic and hybrid search when an admin enables embeddings.',
      },
      {
        title: 'Linked, not piled up',
        body: 'Documents link to each other and form a graph you can browse.',
      },
    ],
    media: {
      type: 'image',
      src: '/images/knowledge-hero.png',
      alt: 'Agor Knowledge graph view showing connected documents in a product and strategy space',
    },
    links: [{ label: 'Knowledge', href: '/guide/knowledge' }],
  },
  {
    id: 'environments',
    navLabel: 'Environments',
    eyebrow: 'See it running',
    title: 'A running {environment} for every branch',
    body: [
      'Each branch is its own isolated checkout, so agents working in parallel do not step on each other’s files. Each can also run its own dev environment, with ports assigned per branch so several can run side by side without collisions.',
      'Start, stop, restart, and read logs from the branch card, or let an agent do it. Reviewers open the same running build instead of setting up their own.',
    ],
    points: [
      {
        title: 'Variants per repo',
        body: 'Ship named setups like lean or full in .agor.yml and pick one per branch.',
      },
      {
        title: 'Deployment-local overrides',
        body: 'Pin host-specific values without touching the shared file.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/env_configuration.png',
      alt: 'Branch environment tab with start, stop, restart, nuke, and view logs controls above the repository environment configuration',
    },
    links: [
      { label: 'Environment configuration', href: '/guide/environment-configuration' },
      { label: 'Branches', href: '/guide/branches' },
    ],
  },
  {
    id: 'artifacts',
    navLabel: 'Artifacts',
    eyebrow: 'Show, don’t tell',
    title: 'Let agents build what you need to [see]',
    body: [
      'Some results are easier to look at than to read. Agents can publish artifacts: live, interactive apps such as dashboards, data explorers, and prototypes that render right on the board.',
      'Ask for a change and the artifact updates in place. Because it lives on the shared board, your colleagues can click through the same thing you are looking at.',
    ],
    points: [
      {
        title: 'No deploy step',
        body: 'Source files are bundled and rendered in the browser with Sandpack.',
      },
      {
        title: 'Iterate live',
        body: 'The agent republishes and the board reloads the artifact for everyone.',
      },
    ],
    media: {
      type: 'image',
      src: '/images/artifacts-hero.png',
      alt: 'Agor board with live interactive artifacts that agents built directly on the canvas',
    },
    links: [{ label: 'Artifacts', href: '/guide/artifacts' }],
  },
  {
    id: 'mcp',
    navLabel: 'MCP',
    eyebrow: 'Connect the tools',
    title: 'Agents drive Agor through the [same API] as you',
    body: [
      'Every session gets its own scoped credentials for Agor’s built-in MCP server, so an agent knows which branch and board it is on and can act there: spawn peers, move cards, start an environment, file knowledge, or report back.',
      'For the rest of your stack, attach external MCP servers to a session, either from the reviewed Catalog or from servers you configure yourself.',
    ],
    points: [
      {
        title: 'No separate server',
        body: 'MCP is part of the Agor daemon. In-Agor agents need no setup.',
      },
      {
        title: 'Same events as the UI',
        body: 'When an agent moves a card, everyone watching the board sees it move.',
      },
      {
        title: 'External servers per session',
        body: 'Give each session the tools its job needs.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/mcp_environment.png',
      alt: 'Agor session where the agent uses Agor MCP tools to look up its session and start the branch environment',
    },
    links: [
      { label: 'Agor MCP server', href: '/guide/internal-mcp' },
      { label: 'External MCP servers', href: '/guide/mcp-servers' },
    ],
  },
  {
    id: 'context-and-cost',
    navLabel: 'Context & cost',
    eyebrow: 'Stay oriented',
    title: 'Know when to keep going and when to [start fresh]',
    body: [
      'With five sessions running across three branches, you need more than scrollback. A context meter behind each conversation fills as its window runs out, so "should I spawn a fresh child or keep going?" is something you can see.',
      'Each prompt also shows what it cost, so you can spot an expensive step while it is happening and switch to a lighter model or effort for the routine ones, mid-session on Claude and Codex.',
    ],
    points: [
      {
        title: 'Cost per step',
        body: 'Input, output, and cache tokens with an estimated cost on each message, where you make the call.',
      },
      {
        title: 'Structured tool blocks',
        body: 'Edits show diffs, commands show exit codes, MCP calls show their inputs and outputs.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/context-meter-timeline.png',
      alt: 'Session timeline with a context-window meter behind each prompt, shifting from green to amber to red as the session fills',
    },
    links: [{ label: 'Rich chat UX', href: '/guide/rich-chat-ux' }],
  },
];
