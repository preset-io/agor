type NavigationItem =
  | string
  | {
      title: string;
      type?: 'separator';
      display?: 'hidden';
    };

/** Canonical documentation tree, shared by guide pages and non-guide surfaces. */
export const guideNavigation: Record<string, NavigationItem> = {
  index: 'Overview',
  'first-teammate': 'Your First AI Teammate',
  'getting-started': 'Getting Started',
  'extended-install': 'Extended Installation',
  'config-yaml': 'Operator Configuration',
  '--- Features': {
    type: 'separator',
    title: 'Features',
  },
  'features-overview': 'Feature Map',
  branches: 'Branches',
  sessions: 'Sessions & Trees',
  boards: 'Boards & Zones',
  teammates: 'Teammates',
  assistants: { title: 'Assistants', display: 'hidden' },
  knowledge: 'Knowledge',
  'internal-mcp': 'Agor MCP Server',
  'mcp-servers': 'External MCP Servers',
  'mcp-egress-gateway': 'MCP Egress Operations',
  'multiplayer-social': 'Multiplayer & Social',
  'environment-configuration': 'Environments',
  scheduler: 'Scheduler',
  'message-gateway': 'Message Gateway',
  'rich-chat-ux': 'Rich Chat UX',
  'in-conversation-widgets': 'In-Conversation Widgets',
  cards: 'Cards (Beta)',
  artifacts: 'Artifacts',
  '--- Reference': {
    type: 'separator',
    title: 'Reference',
  },
  architecture: 'Architecture',
  'typescript-client': 'TypeScript Client',
  'sdk-comparison': 'SDK Comparison',
  'one-time-launch-auth': 'One-Time Launch Auth',
  '--- Development': {
    type: 'separator',
    title: 'Development',
  },
  development: 'Development Guide',
  '--- Deployment': {
    type: 'separator',
    title: 'Deployment',
  },
  'daemon-ha': 'Daemon High Availability',
  'multi-tenant-filesystem': 'Multi-Tenant Filesystem',
  'tenant-data-portability': 'Tenant Data Portability',
  'multiplayer-unix-isolation': 'Execution Isolation',
  'containerized-execution': 'Containerized Execution',
};
