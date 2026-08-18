import { ROOT_COMMANDS } from './command-groups.js';

export type ExecutionPolicy = 'bootstrap' | 'connection' | 'local';

/** Every command is resolved to one context before its implementation runs. */
export function executionPolicyFor(commandId: string): ExecutionPolicy {
  if (commandId === 'help') return 'bootstrap';
  const rootName = commandId.split(':', 1)[0];
  return executionPolicyForRoot(rootName);
}

function executionPolicyForRoot(rootName: string): ExecutionPolicy {
  return ROOT_COMMANDS.find(({ name }) => name === rootName)?.policy ?? 'connection';
}
