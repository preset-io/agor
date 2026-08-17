export type ExecutionPolicy = 'bootstrap' | 'connection' | 'local';

const BOOTSTRAP_COMMANDS = new Set([
  'help',
  'version',
  'init',
  'login',
  'logout',
  'auth:login',
  'auth:logout',
]);

const LOCAL_PREFIXES = ['daemon:', 'db:', 'local:', 'tenant:', 'telemetry:'];
const LOCAL_COMMANDS = new Set([
  'config',
  'doctor',
  'install',
  'branch:cd',
  'repo:add-local',
  'user:create-admin',
]);

/** Every command is resolved to one context before its implementation runs. */
export function executionPolicyFor(commandId: string): ExecutionPolicy {
  if (BOOTSTRAP_COMMANDS.has(commandId)) return 'bootstrap';
  if (
    LOCAL_COMMANDS.has(commandId) ||
    LOCAL_PREFIXES.some((prefix) => commandId.startsWith(prefix))
  ) {
    return 'local';
  }
  return 'connection';
}
