// The syllabus, as data — the single source of truth for every lesson,
// done and planned. Everything else derives from this file:
//
//   - SYLLABUS.md is GENERATED from it (npm run syllabus:md) — edit here,
//     never there;
//   - the reel stitcher (npm run reel) reads it for title overlays and
//     lesson ordering;
//   - a future courseware page can be auto-built from the same records.
//
// Each lesson's `script` is its narrative beat sheet — the steps the spec
// plays out on screen, written for a viewer. Keep it in sync with the spec:
// the beat sheet is the storyboard the spec implements.

export interface LessonMeta {
  /** Stable id — also the spec filename stem and the video filename stem. */
  id: string;
  /** Two-digit lesson number (execution order). */
  number: string;
  /** Short display title — used in overlays and the syllabus table. */
  title: string;
  /** One line for title cards / gallery captions. */
  tagline: string;
  status: 'done' | 'planned';
  /** Needs AGOR_E2E_AGENT_MODE (makes real/replayed model calls). */
  agent: boolean;
  /** The on-screen beat sheet the spec plays out. */
  script: string[];
  /** The state this lesson leaves behind (what the next lesson builds on). */
  endsWith: string;
  /** For planned lessons: notes, blockers, ideas. */
  notes?: string;
}

export const SYLLABUS: LessonMeta[] = [
  {
    id: '00-first-run',
    number: '00',
    title: 'First run',
    tagline: 'A brand-new workspace, and the wizard that greets it',
    status: 'done',
    agent: false,
    script: [
      'Open a signed-in, completely empty Agor — the onboarding wizard greets its first user',
      'Tour the goal cards (personal teammate, ship without busywork, build me an app…)',
      'Pick "Dig into anything" and continue',
      'Skip the optional steps — every one of them gets its own lesson later',
      '"You\'re ready to build." — open the board the wizard created',
    ],
    endsWith: 'An empty board canvas ("Admin\'s board"), ready for real work',
  },
  {
    id: '01-connect-your-repository',
    number: '01',
    title: 'Connect your repository',
    tagline: 'Point Agor at the code — clone a URL or register a local checkout',
    status: 'done',
    agent: false,
    script: [
      'From Home, open the board; the + button opens "Create New..."',
      'The Repository tab: clone from a GitHub URL, or register a clone you already have',
      'Choose "Local (existing)" and enter the donut-shop checkout path',
      'Add Repository — the daemon inspects the clone and registers it',
    ],
    endsWith: 'preset-io/donut-shop registered ("Local repository added successfully!")',
  },
  {
    id: '02-connect-your-ai',
    number: '02',
    title: 'Connect your AI',
    tagline: 'One credential, verified for real — the amber banner tells the truth',
    status: 'done',
    agent: true,
    script: [
      'The "No AI connected" banner has been honest since first run — follow its Connect AI button',
      'Settings → Claude Code: paste a credential and a base URL',
      'The daemon probes the provider with the saved credential',
      'Both amber banners clear — sessions can actually run now',
    ],
    endsWith: 'A verified Claude Code credential; no credential warnings anywhere',
  },
  {
    id: '03-your-first-branch',
    number: '03',
    title: 'Your first branch',
    tagline: 'An isolated worktree with a card on the board',
    status: 'done',
    agent: false,
    script: [
      'Create New... → Branch: pick the donut-shop repo',
      'Worth knowing before naming it: source branch, worktree vs clone storage, issue/PR links',
      'Name it glaze-menu-refresh and create',
      'The card lands on the canvas and the worktree materializes — error-free',
    ],
    endsWith: 'A ready branch card offering "New Session"',
  },
  {
    id: '04-your-first-session',
    number: '04',
    title: 'Your first session',
    tagline: 'A real agent conversation that reads the repo to answer',
    status: 'done',
    agent: true,
    script: [
      'Start a session from the branch card — the panel opens with the coding-agent picker',
      'Agor speaks Claude Code, Codex, Gemini, OpenCode and more; pick Claude Code',
      'Ask for a tour of the repo — the agent reads the code before answering',
      'Follow up: "what would you improve first?" — it digs back in and proposes a concrete fix',
    ],
    endsWith: 'A two-turn transcript ending in "Want me to go ahead and make that change?"',
  },
  {
    id: '05-organize-your-board',
    number: '05',
    title: 'Organize your board',
    tagline: 'Zones turn a canvas into a workflow',
    status: 'done',
    agent: false,
    script: [
      'Draw two zones with the zone tool; rename them inline: "In Progress", "Review"',
      'Peek at zone configuration — a trigger template can fire a prompt when a branch lands',
      'Drag the branch card into "In Progress"',
    ],
    endsWith: 'A board with workflow lanes and the branch filed where it belongs',
  },
  {
    id: '06-capture-knowledge',
    number: '06',
    title: 'Capture knowledge',
    tagline: 'A shared, versioned markdown space agents can read too',
    status: 'done',
    agent: false,
    script: [
      'Open Knowledge from the header; New Page drops straight into the split editor',
      'Write real markdown — the live preview keeps pace, the first heading becomes the title',
      'Save: "Donut Shop Field Notes" joins the knowledge base',
    ],
    endsWith: 'A saved knowledge page, @-mentionable from any session prompt',
  },
  {
    id: '07-parallel-worktrees',
    number: '07',
    title: 'Parallel worktrees',
    tagline: 'Two agents, one repo, zero collisions',
    status: 'done',
    agent: true,
    script: [
      'A second branch off the same repo — quick this time',
      'Its own session plans a "🍩 Daily Special" banner in its own worktree',
      'End wide: two branch cards, two conversations, one repo — nothing steps on anything',
    ],
    endsWith: 'Two live branch cards on the board',
  },
  {
    id: '08-make-the-change',
    number: '08',
    title: 'Make the change',
    tagline: 'From proposal to diff — pick up where lesson 04 left off',
    status: 'planned',
    agent: true,
    script: [
      'Lesson 04 ended with "Want me to go ahead and make that change?" — say yes',
      'Watch the agent edit for real; review the diff in the session panel',
      'The branch card now carries real, uncommitted work',
    ],
    endsWith: 'A reviewed diff on glaze-menu-refresh',
  },
  {
    id: '09-primary-teammate',
    number: '09',
    title: 'A teammate for the board',
    tagline: 'A long-lived agent with identity, memory, and goals',
    status: 'planned',
    agent: true,
    script: [
      'The left panel has said "no primary teammate yet" since lesson 00 — fix that',
      'Create an AI teammate from the framework repo (pre-registered by the harness)',
      "Assign it as the board's primary teammate",
    ],
    endsWith: 'A named teammate presiding over the board',
    notes:
      'Teammate bootstrap may run a setup session — budget model turns; framework repo is already local.',
  },
  {
    id: '10-mcp-tools',
    number: '10',
    title: 'Give your agent tools',
    tagline: 'MCP: ask questions of the live MotherDuck database',
    status: 'planned',
    agent: true,
    script: [
      "Configure the MotherDuck MCP server (donut-shop's own database)",
      'Attach it to a session; ask a data question ("top toppings this month?")',
      'The agent answers from the real database, not the code',
    ],
    endsWith: 'A session with working MCP tools',
    notes:
      'Needs MOTHERDUCK_TOKEN in .e2e-secrets. An Agor-to-Agor MCP against a live Preset instance is a later variant.',
  },
  {
    id: '11-open-a-pr',
    number: '11',
    title: 'Open a pull request',
    tagline: 'Ship the branch: commit, push, PR — from the card',
    status: 'planned',
    agent: true,
    script: [
      'Commit the lesson-08 diff and push the branch',
      'Open a PR and link it on the branch card',
      'The card now wears its PR pill',
    ],
    endsWith: 'A real PR linked from the board',
    notes: 'Needs GitHub write access to donut-shop (or a fork strategy) — decide before building.',
  },
  {
    id: '12-multiplayer',
    number: '12',
    title: 'Multiplayer',
    tagline: 'Two people, live cursors, one board',
    status: 'planned',
    agent: false,
    script: [
      'A second user joins the board in a second browser context',
      'Live presence cursors; both users touch the same canvas',
      'Invite flow becomes its own beat ("Invite a teammate" from the checklist)',
    ],
    endsWith: 'A visibly multiplayer board',
    notes: 'Two Playwright contexts in one spec; needs a second (invited) user account.',
  },
  {
    id: '13-second-provider',
    number: '13',
    title: 'A second provider',
    tagline: 'Codex working alongside Claude',
    status: 'planned',
    agent: true,
    script: [
      'Connect Codex credentials; start a Codex session next to the Claude ones',
      'Same board, different runtimes',
    ],
    endsWith: 'Mixed-provider sessions on one board',
    notes:
      'LIVE-ONLY for now: the Codex CLI ignores OPENAI_BASE_URL (verified — a stub upstream got zero hits), so its traffic cannot be cassette-recorded without deeper provider-config plumbing.',
  },
];

export const DONE_LESSONS = SYLLABUS.filter((lesson) => lesson.status === 'done');
export const PLANNED_LESSONS = SYLLABUS.filter((lesson) => lesson.status === 'planned');
