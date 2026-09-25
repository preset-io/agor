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
  '--- Getting started': { type: 'separator', title: 'Getting started' },
  'first-teammate': 'Your First AI Teammate',
  'getting-started': 'Getting Started',
  '--- Using Agor': { type: 'separator', title: 'Using Agor' },
  'features-overview': 'Feature Map',
  branches: 'Branches',
  sessions: 'Sessions & Trees',
  boards: 'Boards & Zones',
  teammates: 'Teammates',
  assistants: { title: 'Assistants', display: 'hidden' },
  knowledge: 'Knowledge',
  'mcp-servers': 'MCP Catalog & Connections',
  'mcp-egress-gateway': { title: 'MCP Egress Operations', display: 'hidden' },
  'multiplayer-social': 'Multiplayer & Social',
  permissions: 'Sharing & Permissions',
  'environment-configuration': 'Branch Environments',
  scheduler: 'Scheduler',
  'message-gateway': 'Message Gateway',
  'rich-chat-ux': 'Rich Chat UX',
  'in-conversation-widgets': 'In-Conversation Widgets',
  cards: 'Cards (Beta)',
  artifacts: 'Artifacts',
  '--- Operating Agor': { type: 'separator', title: 'Operating Agor' },
  operating: 'Operator Overview',
  'extended-install': 'Installation Options',
  'config-yaml': 'Deployment Configuration',
  'multiplayer-unix-isolation': 'Execution Isolation & Upgrades',
  'mcp-administration': 'MCP Administration',
  'containerized-execution': 'Containerized Execution',
  'daemon-ha': 'Daemon High Availability',
  'multi-tenant-filesystem': 'Multi-Tenant Filesystem',
  'tenant-data-portability': 'Tenant Data Portability',
  'one-time-launch-auth': 'One-Time Launch Auth',
  '--- Developing & Reference': { type: 'separator', title: 'Developing & Reference' },
  development: 'Development Guide',
  architecture: 'Architecture',
  'typescript-client': 'TypeScript Client',
  'internal-mcp': 'Agor MCP Server',
  'sdk-comparison': 'Agent & SDK Comparison',
};
