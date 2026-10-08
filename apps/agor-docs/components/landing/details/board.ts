import type { LandingDetail } from './types';

export const boardDetails: LandingDetail[] = [
  {
    id: 'presence',
    navLabel: 'Live presence',
    eyebrow: 'One shared view',
    title: 'Everyone on the [same board]',
    body: [
      'Agent work usually happens in private terminals, so the only way to see it is a screenshot or a status message. On an Agor board, your team and its agents share one live canvas. If you’ve worked in Figma, you already know how this feels.',
      'Live cursors show where each person is working, and the facepile shows who is online. When you see a colleague hovering over a session, you can jump in instead of asking for an update.',
    ],
    points: [
      {
        title: 'Live cursors',
        body: 'Names and positions update as people move, so you coordinate instead of stepping on each other.',
      },
      {
        title: 'Facepile',
        body: 'See who is online and click through to the board they are on, when you can see it too.',
      },
      {
        title: 'Moves everyone sees',
        body: 'Drag a branch to a new spot and it moves for everyone watching the board.',
      },
    ],
    media: {
      type: 'video',
      src: '/videos/showcase-multiplayer.mp4',
      srcSmall: '/videos/showcase-multiplayer-540.mp4',
      poster: '/videos/showcase-multiplayer-poster.jpg',
      alt: 'Two people working on the same Agor board, with live cursors, a shared session, and queued follow-up prompts.',
    },
    links: [{ label: 'Multiplayer & social', href: '/guide/multiplayer-social' }],
  },
  {
    id: 'boards-and-zones',
    navLabel: 'Boards & zones',
    eyebrow: 'Structure you can see',
    title: 'Give every piece of work a {place}',
    body: [
      'Each branch lives at a spot on a 2D board, with its sessions shown as a tree on the card. People remember where things are: the auth work in the top left, the experiments down below. A board keeps that sense of place instead of flattening it into a list.',
      'Zones mark the stages of your work. Drop a branch into a zone like "Code review" or "Needs tests" and its prompt template runs with the branch, issue, and PR details filled in, so the next step starts where the work already is.',
    ],
    points: [
      {
        title: 'Boards per team or project',
        body: 'A PR review board, a bug triage board, a roadmap board. Each has its own branches, zones, and members.',
      },
      {
        title: 'Zones that trigger work',
        body: 'Chain zones into a pipeline, from triage to review to ship, and drag work through it.',
      },
      {
        title: 'Cards beyond code',
        body: 'Cards put tickets, leads, or content pieces on the same canvas, managed by an AI teammate.',
      },
    ],
    media: {
      type: 'video',
      src: '/videos/showcase-boards.mp4',
      srcSmall: '/videos/showcase-boards-540.mp4',
      poster: '/videos/showcase-boards-poster.jpg',
      alt: 'An Agor board with branch cards arranged across colored zones, markdown notes, and agent sessions.',
    },
    links: [
      { label: 'Boards & zones', href: '/guide/boards' },
      { label: 'Reusable zone prompts', href: '/command-center#zones-and-prompts' },
      { label: 'Cards', href: '/guide/cards' },
    ],
  },
  {
    id: 'attention',
    navLabel: 'What needs you',
    eyebrow: 'Stay sane with many agents',
    title: 'Know which agent [needs you]',
    body: [
      'Running many agents creates coordination work of its own. Which session is blocked? Which one finished? The board answers at a glance: a branch card glows when a session is ready for input or a long run has finished.',
      'You don’t have to watch the board to keep up. Favicon status dots and completion chimes tell you when something needs you from another tab.',
    ],
    points: [
      {
        title: 'Attention glow',
        body: 'Cards pulse when a session waits for input or a spawned child reports back.',
      },
      {
        title: 'Status in the tab',
        body: 'The favicon shows whether anything is running or waiting, even when Agor is in the background.',
      },
      {
        title: 'Cost per prompt',
        body: 'Token counts and estimated cost show on every message and roll up per session.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/branch-highlighted.png',
      alt: 'Two branch cards on an Agor board, one glowing teal because its session needs attention.',
    },
    links: [
      { label: 'Attention pulse', href: '/guide/multiplayer-social' },
      { label: 'Status indicators', href: '/guide/rich-chat-ux' },
    ],
  },
  {
    id: 'sessions',
    navLabel: 'Agent sessions',
    eyebrow: 'Follow the agent',
    title: 'Watch the work [unfold]',
    body: [
      'Open a session and follow the agent as it works: tool calls, decisions, todo lists, and handoffs, with the full context in one place. Anyone who can see the branch can read along, so reviewing an agent’s approach doesn’t mean asking someone to paste a transcript.',
      'Sessions branch like the work does. Fork one to try an alternative, spawn a child session to hand off a focused task, and see the whole tree on the branch card.',
    ],
    points: [
      {
        title: 'Structured tool blocks',
        body: 'Each tool call renders as its own block, so you can scan what the agent did.',
      },
      {
        title: 'Queued follow-ups',
        body: 'Type the next instruction while the agent is still working; it runs as soon as the agent finishes.',
      },
      {
        title: 'Session trees',
        body: 'Forks and spawned children stay linked to their parent, and children report back when they finish.',
      },
    ],
    media: {
      type: 'video',
      src: '/videos/showcase-sessions.mp4',
      srcSmall: '/videos/showcase-sessions-540.mp4',
      poster: '/videos/showcase-sessions-poster.jpg',
      alt: 'An Agor session conversation showing an agent’s tool calls and decisions as it works.',
    },
    links: [
      { label: 'Sessions & trees', href: '/guide/sessions' },
      { label: 'Rich chat UX', href: '/guide/rich-chat-ux' },
    ],
  },
  {
    id: 'gateway',
    navLabel: 'Slack & more',
    eyebrow: 'No board required',
    title: 'Bring agents into the [threads you use]',
    body: [
      'Not everyone needs to live on the canvas. Mention your Agor bot in Slack or Discord, @mention it on a GitHub pull request, or tag it in a Shortcut story, and it starts a session on the right branch and replies in the same thread.',
      'The work still shows up on the board, so people who prefer the canvas can follow along while everyone else stays in the conversation they started.',
    ],
    points: [
      {
        title: 'Where your team talks',
        body: 'Slack, Discord, GitHub, and Shortcut today, with Microsoft Teams coming soon to Agor Cloud.',
      },
      {
        title: 'Runs as the right person',
        body: 'Messages are matched to Agor users, so sessions run under the sender’s identity, and unmatched senders are rejected.',
      },
      {
        title: 'Configured per channel',
        body: 'Each channel sets its own agent, model, permission mode, and MCP servers.',
      },
    ],
    media: {
      type: 'video',
      src: '/videos/showcase-gateway.mp4',
      srcSmall: '/videos/showcase-gateway-540.mp4',
      poster: '/videos/showcase-gateway-poster.jpg',
      alt: 'A Slack thread where someone mentions an Agor teammate and the agent replies with a link to its session.',
    },
    links: [{ label: 'Message gateway', href: '/guide/message-gateway' }],
  },
  {
    id: 'comments',
    navLabel: 'Comments',
    eyebrow: 'Shape it together',
    title: 'Discuss the work [where it lives]',
    body: [
      'Agent conversations scroll away. Comments stay put. Pin a threaded comment to a board, a zone, a branch, or a session, right where the question comes up.',
      'Mention a colleague, reply in a thread, and link straight to the session in question. The next person to open that branch finds the discussion next to the work instead of digging through a transcript.',
    ],
    points: [
      {
        title: 'Scoped threads',
        body: 'Board, zone, branch, and session comments, organized by scope in one panel.',
      },
      {
        title: '@mentions',
        body: 'Pull a teammate into the exact spot that needs their eyes.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/marketing/agor-marketing-social-comment-context.png',
      alt: 'A comment from a teammate attached to a branch card on an Agor board, asking a question about the work in progress.',
    },
    links: [{ label: 'Spatial comments', href: '/guide/multiplayer-social' }],
  },
];
