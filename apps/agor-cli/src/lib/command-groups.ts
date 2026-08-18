import type { ExecutionPolicy } from './execution-policy.js';

export type DeploymentGroup = 'connected' | 'local';
export interface RootCommandMetadata {
  name: string;
  description: string;
  group: DeploymentGroup;
  policy: ExecutionPolicy;
}

export const ROOT_COMMANDS = [
  {
    name: 'config',
    description: 'Show the effective local deployment configuration',
    group: 'local',
    policy: 'local',
  },
  {
    name: 'daemon',
    description: 'Manage the local daemon lifecycle',
    group: 'local',
    policy: 'local',
  },
  { name: 'db', description: 'Manage the local database', group: 'local', policy: 'local' },
  { name: 'doctor', description: 'Check the local installation', group: 'local', policy: 'local' },
  {
    name: 'init',
    description: 'Initialize a local deployment',
    group: 'local',
    policy: 'bootstrap',
  },
  {
    name: 'install',
    description: 'Manage locally installed agentic tools',
    group: 'local',
    policy: 'local',
  },
  {
    name: 'local',
    description: 'Run local filesystem operations',
    group: 'local',
    policy: 'local',
  },
  {
    name: 'telemetry',
    description: 'Manage local telemetry configuration',
    group: 'local',
    policy: 'local',
  },
  {
    name: 'tenant',
    description: 'Manage local tenant data operations',
    group: 'local',
    policy: 'local',
  },
  {
    name: 'login',
    description: 'Select and authenticate with a deployment',
    group: 'connected',
    policy: 'bootstrap',
  },
  {
    name: 'logout',
    description: 'Clear the current deployment connection',
    group: 'connected',
    policy: 'bootstrap',
  },
  {
    name: 'open',
    description: 'Open the local deployment',
    group: 'local',
    policy: 'connection',
  },
  {
    name: 'version',
    description: 'Show the local daemon version',
    group: 'local',
    policy: 'connection',
  },
  { name: 'board', description: 'Manage boards', group: 'connected', policy: 'connection' },
  {
    name: 'branch',
    description: 'Manage branches and environments',
    group: 'connected',
    policy: 'connection',
  },
  {
    name: 'mcp',
    description: 'Manage MCP servers',
    group: 'connected',
    policy: 'connection',
  },
  {
    name: 'repo',
    description: 'Manage repositories',
    group: 'connected',
    policy: 'connection',
  },
  {
    name: 'session',
    description: 'Inspect agent sessions',
    group: 'connected',
    policy: 'connection',
  },
  {
    name: 'user',
    description: 'Manage user accounts',
    group: 'connected',
    policy: 'connection',
  },
] as const satisfies readonly RootCommandMetadata[];

export const LOCAL_DEPLOYMENT_COMMANDS = ROOT_COMMANDS.filter(({ group }) => group === 'local');
export const CONNECTED_DEPLOYMENT_COMMANDS = ROOT_COMMANDS.filter(
  ({ group }) => group === 'connected'
);
