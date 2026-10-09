import { type BranchEnvironmentInstance, hasActiveEnvironmentCommand } from '@agor/core/types';
import type { CompactNoticeDetail } from '../CompactNotice';

type CommandAction = NonNullable<BranchEnvironmentInstance['last_command']>['action'];

export const ENVIRONMENT_NO_CONTROL =
  'You need full control of this branch to control its environment.';
export const ENVIRONMENT_NOT_CONFIGURED =
  'No environment set up yet. Use the edit button to add one.';
export const ENVIRONMENT_HEALTH_FAILED = 'Running, but the health check failed.';
export const ENVIRONMENT_REPORTED_ERROR = 'The environment reported an error.';

export const DIDNT_FINISH: Record<CommandAction, string> = {
  start: "The environment didn't start.",
  stop: "The environment didn't stop.",
  restart: "The environment didn't restart.",
  nuke: "The nuke didn't finish.",
};

const FAILED_LABEL: Record<CommandAction, string> = {
  start: "Didn't start",
  stop: "Didn't stop",
  restart: "Didn't restart",
  nuke: "Nuke didn't finish",
};

const PAST_TENSE: Partial<Record<CommandAction, string>> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
};

const lastUnconfirmed = (action: CommandAction) =>
  `Agor couldn't confirm the last ${action}. Check the logs before you try again.`;

/**
 * The settled command behind an `error` status. Core also writes `error` for
 * unknown outcomes, which the UI shows as a warning because they're recoverable.
 */
export function getEnvironmentOutcome(env?: BranchEnvironmentInstance) {
  if (env?.status !== 'error' || hasActiveEnvironmentCommand(env)) return null;
  const result = env.last_command;
  if (!result || result.status === 'succeeded') return null;
  return result as typeof result & { status: 'failed' | 'unknown' };
}

/** Short status label (0.2 vocabulary) for error and unhealthy states; null keeps the caller's label. */
export function getEnvironmentProblemLabel(env?: BranchEnvironmentInstance): string | null {
  const outcome = getEnvironmentOutcome(env);
  if (outcome) return outcome.status === 'failed' ? FAILED_LABEL[outcome.action] : 'Not confirmed';
  if (env?.status === 'running' && env.last_health_check?.status === 'unhealthy') {
    return 'Health check failed';
  }
  return null;
}

/** One-line pill tooltip for error and unhealthy states. */
export function getEnvironmentProblemLine(env?: BranchEnvironmentInstance): string | null {
  const outcome = getEnvironmentOutcome(env);
  if (outcome) {
    return outcome.status === 'failed'
      ? `${DIDNT_FINISH[outcome.action]} Check the logs.`
      : lastUnconfirmed(outcome.action);
  }
  if (env?.status === 'error') return ENVIRONMENT_REPORTED_ERROR;
  if (env?.status === 'running' && env.last_health_check?.status === 'unhealthy') {
    const message = env.last_health_check.message;
    return message ? `${ENVIRONMENT_HEALTH_FAILED} (${message})` : ENVIRONMENT_HEALTH_FAILED;
  }
  return null;
}

export interface EnvironmentProblemNotice {
  type: 'error' | 'warning';
  message: string;
  details?: CompactNoticeDetail[];
}

const detail = (label: string, value?: string): CompactNoticeDetail[] | undefined =>
  value ? [{ label, value, code: true }] : undefined;

/** Banner for the Environment tab. `last_error` only shows while the status is `error`, so stale text never resurfaces. */
export function getEnvironmentProblemNotice(
  env?: BranchEnvironmentInstance
): EnvironmentProblemNotice | null {
  const outcome = getEnvironmentOutcome(env);
  if (outcome?.status === 'failed') {
    return {
      type: 'error',
      message: DIDNT_FINISH[outcome.action],
      details: detail('Output', outcome.message),
    };
  }
  if (outcome) {
    const past = PAST_TENSE[outcome.action];
    return {
      type: 'warning',
      message: past
        ? `Agor couldn't confirm the environment ${past}. Check the logs before you try again.`
        : lastUnconfirmed(outcome.action),
      details: detail('Result', outcome.message),
    };
  }
  if (env?.status === 'error' && !hasActiveEnvironmentCommand(env)) {
    return {
      type: 'error',
      message: ENVIRONMENT_REPORTED_ERROR,
      details: detail('Error', env.last_error),
    };
  }
  if (env?.status === 'running' && env.last_health_check?.status === 'unhealthy') {
    return {
      type: 'warning',
      message: ENVIRONMENT_HEALTH_FAILED,
      details: detail('Health check', env.last_health_check.message),
    };
  }
  return null;
}
