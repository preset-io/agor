import { AI_ENABLEMENT_POST_URL } from '../../../lib/links';
import type { LandingDetail } from './types';

export const multiplayerDetails: LandingDetail[] = [
  {
    id: 'learn-together',
    navLabel: 'Learn together',
    eyebrow: 'Learn from each other',
    title: 'Get better at AI [together]',
    body: [
      'Most AI work happens behind one person’s screen, so good techniques stay private and the same mistakes get made twice. Agor puts every session on a shared board, where you can open a colleague’s session and follow the whole conversation: the prompts, the tool calls, and the decisions that got a good result.',
      'When something works, the team keeps it instead of rediscovering it.',
    ],
    points: [
      {
        title: 'Read the whole thread',
        body: 'Sessions live on branch cards, not in someone’s scrollback, so anyone on the board can see how the work got done.',
      },
      {
        title: 'Try your own take',
        body: 'Fork a colleague’s Claude Code or Codex session to explore a different approach without disturbing theirs.',
      },
      {
        title: 'Keep what works',
        body: 'Save decisions and runbooks to the shared knowledge base, and turn a good prompt into a zone trigger anyone can reuse.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/marketing/agor-marketing-board-wide.png',
      alt: 'A shared Agor board with zones for shipping, review, and assistants, branch cards running Claude, Codex, Gemini, and OpenCode sessions, and named cursors for several teammates',
    },
    links: [
      { label: 'Sessions & forks', href: '/guide/sessions' },
      { label: 'Knowledge', href: '/guide/knowledge' },
      { label: 'Zone triggers', href: '/guide/boards' },
    ],
  },
  {
    id: 'live-presence',
    navLabel: 'Live presence',
    eyebrow: 'Live presence',
    title: 'See who’s working on [what]',
    body: [
      'No more “share your screen” calls to find out what a teammate’s agent is doing. Live cursors show where everyone is on the board, the facepile shows who is online and which board they’re on, and branch cards pulse when a session is waiting on someone.',
    ],
    points: [
      {
        title: 'Live cursors',
        body: 'Names and positions update about ten times a second, so you can coordinate instead of stepping on each other.',
      },
      {
        title: 'Facepile',
        body: 'See who’s online and jump to the board they’re on, when you have access to it.',
      },
      {
        title: 'Attention pulse',
        body: 'Branches glow when a session needs input or a long run finishes, even from a background tab.',
      },
    ],
    media: {
      type: 'video',
      src: '/videos/showcase-multiplayer.mp4',
      srcSmall: '/videos/showcase-multiplayer-540.mp4',
      poster: '/videos/showcase-multiplayer-poster.jpg',
      alt: 'Teammates’ cursors moving across a shared Agor board while agent sessions update on branch cards',
    },
    links: [{ label: 'Multiplayer & social', href: '/guide/multiplayer-social' }],
  },
  {
    id: 'shared-environments',
    navLabel: 'Shared environments',
    eyebrow: 'Shared dev environments',
    title: 'One running build for the [whole team]',
    body: [
      'Every branch can run its own dev environment on its own ports, so five features can run side by side. Configure the environment once for the repo, and everyone on the team gets one-click start and stop on every branch.',
      'Engineers, reviewers, PMs, and QA open the same running build instead of each spinning up their own to see it.',
    ],
    points: [
      {
        title: 'Configured once, in the repo',
        body: 'An .agor.yml file describes the environment, so it’s reviewed and shared like any other code.',
      },
      {
        title: 'No port fights',
        body: 'Ports are derived from each branch, so parallel branches never collide.',
      },
      {
        title: 'Shared terminals',
        body: 'When two people open the same branch’s terminal, they see each other’s keystrokes live.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/branch-anatomy.png',
      alt: 'A branch card with its pull request, a running environment indicator, and a coordinator session with parallel review sessions from Codex, Claude, and Gemini',
    },
    links: [
      { label: 'Environments', href: '/guide/environment-configuration' },
      { label: 'Branches', href: '/guide/branches' },
    ],
  },
  {
    id: 'shared-terminals',
    navLabel: 'Shared terminals',
    eyebrow: 'Hands on the same keyboard',
    title: 'Work in the [same terminal]',
    body: [
      'Open a branch’s terminal and anyone else on that branch sees the same session live: every keystroke, every output. Pair on a fix, walk a new teammate through a setup, or explore a branch together during review.',
    ],
    points: [
      {
        title: 'Branch-scoped',
        body: 'Each branch gets its own shared terminal, open to teammates who have access to it.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/tmux.png',
      alt: 'Shared tmux terminal on an Agor branch, split into panes showing commands and output from the same session',
    },
    links: [{ label: 'Terminal trust boundaries', href: '/security' }],
  },
  {
    id: 'comments',
    navLabel: 'Comments',
    eyebrow: 'Spatial comments',
    title: 'Talk about the work {where it lives}',
    body: [
      'Agent conversations scroll away. Comments stay pinned to the board, zone, branch, or session they’re about, so a colleague finds the note right next to the work instead of digging through a transcript.',
    ],
    points: [
      {
        title: 'Threads and mentions',
        body: 'Reply in threads and @mention a teammate to pull them into the right spot.',
      },
      {
        title: 'Organized by scope',
        body: 'The comments panel groups discussion by board, zone, branch, and session.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/marketing/agor-marketing-social-comment-context.png',
      alt: 'A teammate’s comment pinned to a branch card on the board, asking a question about the facepile while Gemini and Codex sessions run on that branch',
    },
    links: [{ label: 'Comments guide', href: '/guide/multiplayer-social' }],
  },
  {
    id: 'any-agent',
    navLabel: 'Any agent',
    eyebrow: 'Bring your agents',
    title: 'Work with the agents your team [already uses]',
    body: [
      'Claude Code, Codex, Gemini, GitHub Copilot, and OpenCode all run on the same board, with Cursor in beta. Pick the right agent for each session, mix them on one branch, and switch when something better ships.',
      'Everyone keeps their own settings and credentials, so a team can share boards and conversations without sharing secrets.',
    ],
    points: [
      {
        title: 'Your provider, your subscription',
        body: 'Each person brings their own credentials, or uses workspace ones, depending on how your team sets it up.',
      },
      {
        title: 'Per-person defaults',
        body: 'Default model and permission mode are set per person and per agent.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/per-user-agentic-default-settings.png',
      alt: 'The Edit User dialog on the Codex tab, with a default model and a choice of permission modes',
    },
    links: [
      { label: 'Supported agents', href: '/guide/sdk-comparison' },
      { label: 'Per-user settings', href: '/guide/multiplayer-social' },
    ],
  },
  {
    id: 'enablers',
    navLabel: 'For AI enablers',
    eyebrow: 'For AI enablers',
    title: 'Turn one person’s wins into [team] practice',
    body: [
      'Handing out AI accounts doesn’t change how a team works. If you’re the person already getting great results, Agor gives you a way to make that work visible, bring colleagues into it, and turn it into workflows the rest of the team can use and improve.',
      'That person is your AI enabler. At Preset we call the role the AI Enablement Engineer, and Agor is built to be their workbench.',
      'You don’t need the whole team on day one. Start on your own, then invite people in as the work becomes worth sharing.',
    ],
    points: [
      {
        title: 'Start on your own',
        body: 'Install Agor, connect your agents, and set up your first teammate.',
      },
      {
        title: 'Bring colleagues in',
        body: 'Share a board, point people at the sessions and prompts that work, and let them build on them.',
      },
      {
        title: 'Make it repeatable',
        body: 'Zone triggers, shared knowledge, and AI teammates turn a one-off success into something anyone can run.',
      },
    ],
    links: [
      { label: 'What is an AI Enablement Engineer?', href: AI_ENABLEMENT_POST_URL },
      { label: 'Get started', href: '/guide/getting-started' },
      { label: 'Your first teammate', href: '/guide/first-teammate' },
      { label: 'AI teammates', href: '/teammates' },
    ],
  },
];
