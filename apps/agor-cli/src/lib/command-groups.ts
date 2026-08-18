export type RootCommandEntry = readonly [name: string, description: string];

export const LOCAL_DEPLOYMENT_COMMANDS = [
  ['config', 'Show the effective local deployment configuration'],
  ['daemon', 'Manage the local daemon lifecycle'],
  ['db', 'Manage the local database'],
  ['doctor', 'Check the local installation'],
  ['init', 'Initialize a local deployment'],
  ['install', 'Manage locally installed agentic tools'],
  ['local', 'Run local filesystem operations'],
  ['telemetry', 'Manage local telemetry configuration'],
  ['tenant', 'Manage local tenant data operations'],
] as const satisfies readonly RootCommandEntry[];

export const CONNECTED_DEPLOYMENT_COMMANDS = [
  ['login', 'Select and authenticate with a deployment'],
  ['logout', 'Clear the current deployment connection'],
  ['open', 'Open the connected deployment'],
  ['version', 'Show the connected daemon version'],
  ['board', 'Manage boards'],
  ['branch', 'Manage branches and environments'],
  ['mcp', 'Manage MCP servers'],
  ['repo', 'Manage repositories'],
  ['session', 'Inspect agent sessions'],
  ['user', 'Manage user accounts'],
] as const satisfies readonly RootCommandEntry[];
