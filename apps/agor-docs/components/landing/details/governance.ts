import type { LandingDetail } from './types';

export const governanceDetails: LandingDetail[] = [
  {
    id: 'visibility',
    navLabel: 'Visibility',
    eyebrow: 'What’s running',
    title: 'See the work, and [what it costs]',
    body: [
      'Every agent session lives on a shared board, next to the branch it works on. Anyone with access can see what is running, what is waiting on a person, and what an agent actually did, without chasing status updates.',
      'Estimated cost is recorded on every message and rolls up per session, so whoever looks after AI spend can see where it goes, and catch a runaway prompt or an oversized model before it becomes a pattern.',
    ],
    points: [
      {
        title: 'Cost on the record',
        body: 'Estimated cost stays attached to each session and branch, next to the work it paid for. Coverage depends on what each agent’s SDK reports.',
      },
      {
        title: 'Usage analytics',
        body: 'Settings → Analytics shows how agents are being used across the workspace.',
      },
      {
        title: 'A record of agent work',
        body: 'Conversations, tool calls, and branch history stay attached to the session, including after a branch is archived.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/cost-tooltip.png',
      alt: 'Session footer with a tooltip listing input, output, and cache tokens and an estimated cost for the session',
    },
    links: [
      { label: 'Cost & token accounting', href: '/guide/rich-chat-ux' },
      { label: 'Token tracking by agent', href: '/guide/sdk-comparison' },
    ],
  },
  {
    id: 'permissions',
    navLabel: 'Permissions',
    eyebrow: 'Who can do what',
    title: 'Decide {who can do what} on every board',
    body: [
      'Board and branch permissions are always on. Every board and branch has a primary owner, and you grant access to named people, groups, or everyone else in the workspace.',
      'Roles stay simple: Viewers read, Collaborators prompt their own sessions, Managers run the branch. File access is set separately, and Manager never implies access to someone else’s sessions or credentials.',
    ],
    points: [
      {
        title: 'Board defaults, branch overrides',
        body: 'A board sets one default permission package; a branch inherits it or overrides it as a whole.',
      },
      {
        title: 'File access: none, read, or write',
        body: 'Terminal access requires Collaborator or Manager plus file access.',
      },
      {
        title: 'Shared prompting is opt-in',
        body: 'A workspace admin enables it first, then a board or branch Manager turns it on where it fits.',
      },
    ],
    media: { type: 'roleMatrix' },
    links: [
      { label: 'Board and branch permissions', href: '/security' },
      { label: 'Execution isolation guide', href: '/guide/multiplayer-unix-isolation' },
    ],
  },
  {
    id: 'model-choice',
    navLabel: 'Model choice',
    eyebrow: 'No frontier lock-in',
    title: 'Run {any agent}, and switch when you need to',
    body: [
      'Claude Code, Codex, Gemini, GitHub Copilot, and OpenCode run side by side on the same board, with Cursor in beta. Pick the agent and model per session, and change model or reasoning effort mid-session where the agent supports it.',
      'Your workflows stay on your board, not inside one provider’s product, so trying something new does not mean starting over.',
    ],
    points: [
      {
        title: 'Your keys, your bill',
        body: 'Bring your own provider keys or subscriptions. Per-user keys take precedence over shared ones and are encrypted at rest.',
      },
      {
        title: 'Compare on the same work',
        body: 'Run several agents against one branch and review their results together.',
      },
    ],
    media: {
      type: 'image',
      src: '/security_audit.png',
      alt: 'Branch card with three sessions running the same security audit in Claude, Codex, and Gemini',
    },
    links: [{ label: 'Agent feature comparison', href: '/guide/sdk-comparison' }],
  },
  {
    id: 'isolation',
    navLabel: 'Isolation',
    eyebrow: 'Where agent code can reach',
    title: 'Pick an [execution boundary] that fits your team',
    body: [
      'Permissions decide who can use a branch. The execution mode decides which files and credentials agent code can actually reach. Agor keeps those two controls separate, and you choose the boundary that matches who can reach the daemon.',
      'The browser terminal and message gateway channels are the two places people reach agent context most directly, so match them to your execution mode and channel settings. Security covers every trust boundary in detail.',
    ],
    points: [
      {
        title: 'Simple',
        body: 'Agents and terminals run as the daemon user with no filesystem boundary. Meant for one person or a fully trusted team.',
      },
      {
        title: 'Sandbox',
        body: 'A fail-closed Linux bubblewrap sandbox with mounts derived from branch permissions and a private home per person. It isolates the filesystem, not the network, and never falls back to simple.',
      },
      {
        title: 'Delegated',
        body: 'Hands execution to an external launcher, such as containers or pods. That substrate owns identity, storage, and containment.',
      },
    ],
    links: [
      { label: 'Every trust boundary', href: '/security' },
      {
        label: 'Why we left Unix impersonation',
        href: '/blog/why-agor-is-leaving-unix-impersonation-behind',
      },
    ],
  },
  {
    id: 'self-hosted',
    navLabel: 'Community Edition',
    eyebrow: 'Agor Community Edition',
    title: 'Run it {yourself}, on your terms',
    body: [
      'Agor Community Edition installs from npm and runs on your own infrastructure. It is source-available under BSL 1.1, production use is permitted, and your repos, database, and infrastructure stay yours.',
      'Stored credentials are encrypted at rest under a master secret you provision, and agents run in separate executor processes that receive API keys just in time instead of reading the database.',
    ],
    points: [
      {
        title: 'Keep the daemon private',
        body: 'Run it behind a firewall, VPN, or private network, and put a reverse proxy in front for SSO or IP allowlists.',
      },
      {
        title: 'Per-person credentials',
        body: 'API keys and environment variables are stored per user, and reads expose only names and presence, never values.',
      },
      {
        title: 'Your analytics, your pipeline',
        body: 'Off by default. Turn it on and Agor sends curated lifecycle events to the analytics destination you choose, filtered how you like.',
      },
    ],
    media: {
      type: 'image',
      src: '/screenshots/per-user-api-keys.png',
      alt: 'Edit User dialog showing per-user Anthropic, OpenAI, and Gemini API key fields, noted as encrypted at rest',
    },
    links: [
      { label: 'Install Community Edition', href: '/guide/getting-started' },
      { label: 'Deployment guidance', href: '/security' },
      { label: 'Analytics configuration', href: '/guide/config-yaml' },
      { label: 'Containerized execution', href: '/guide/containerized-execution' },
    ],
  },
  {
    id: 'cloud',
    navLabel: 'Agor Cloud',
    eyebrow: 'Or let us run it',
    title: 'Prefer not to operate it? Try [Agor Cloud]',
    body: [
      'Agor Cloud is fully managed Agor, operated by the team behind Preset Cloud. It runs a hardened, current release with isolation, governance, and observability handled for you, while your team keeps its own model keys.',
      'Start on our infrastructure and move closer to your own as requirements grow, from hosted to a managed deployment in your AWS account.',
    ],
    points: [
      {
        title: 'Separate workspaces',
        body: 'Each workspace is its own tenant with its own database, so you can segment by team, project, or sensitivity.',
      },
      {
        title: 'Your keys stay yours',
        body: 'Model usage is billed by your provider. Agor Cloud does not proxy or mark up your tokens.',
      },
      {
        title: 'SOC 2 Type II in progress',
        body: 'The audit is underway, and sign-in runs through a SOC 2 Type II identity provider.',
      },
    ],
    media: {
      type: 'image',
      src: '/images/blog/agor-cloud.png',
      alt: 'Illustration of a managed cloud connected to security, access, and monitoring panels',
    },
    links: [
      { label: 'Agor Cloud', href: '/cloud' },
      { label: 'The announcement', href: '/blog/agor-cloud' },
    ],
  },
];
