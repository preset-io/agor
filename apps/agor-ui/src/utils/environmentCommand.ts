import { type BranchEnvironmentInstance, hasActiveEnvironmentCommand } from '@agor/core/types';

const actionLabels = { start: 'Start', stop: 'Stop', restart: 'Restart', nuke: 'Nuke' };

/** Command completion is deliberately separate from application health. */
export function getEnvironmentCommandStatus(environment?: BranchEnvironmentInstance): {
  text: string;
  type: 'info' | 'error' | 'warning';
} | null {
  const attempt = environment?.command_attempt;
  if (attempt && hasActiveEnvironmentCommand(environment)) {
    return {
      text: `${actionLabels[attempt.action]} ${attempt.claimed_at ? 'executing' : 'queued'}`,
      type: 'info',
    };
  }
  const result = environment?.last_command;
  const actionName = result?.action ?? attempt?.action;
  if (actionName) {
    const action = actionLabels[actionName];
    switch (result?.status) {
      case 'succeeded':
        return { text: `${action} completed`, type: 'info' };
      case 'failed':
        return { text: `${action} failed`, type: 'error' };
      default:
        return { text: `${action} outcome unknown`, type: 'warning' };
    }
  }
  return environment?.last_error ? { text: 'Environment error', type: 'error' } : null;
}

export function hasEnvironmentCommandLogs(environment?: BranchEnvironmentInstance): boolean {
  return !!(
    environment?.command_attempt ||
    environment?.last_command ||
    environment?.last_error ||
    environment?.command_history?.length
  );
}
