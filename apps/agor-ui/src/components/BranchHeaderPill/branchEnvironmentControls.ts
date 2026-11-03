import { hasActiveEnvironmentCommand } from '@agor/core/types';
import type { Branch, Repo } from '@agor-live/client';
import { getEnvironmentAccessUrls } from '../../utils/environmentAccessUrls';
import { getEffectiveEnv } from '../../utils/environmentConfig';
import { ENVIRONMENT_NO_CONTROL } from '../EnvironmentPill/environmentStatusCopy';

/** The branch environment's state and which controls apply, shared by every branch surface. */
export function getBranchEnvironmentControls(
  repo: Repo,
  branch: Branch,
  {
    canControlEnvironment = true,
    connectionDisabled = false,
    canStart,
    canStopHandler,
  }: {
    canControlEnvironment?: boolean;
    connectionDisabled?: boolean;
    /** Whether a start handler is wired. */
    canStart: boolean;
    /** Whether a stop handler is wired. */
    canStopHandler: boolean;
  }
) {
  const effectiveEnv = getEffectiveEnv(repo);
  const hasConfig = effectiveEnv.hasConfig;
  const env = branch.environment_instance;
  const environmentUrl = getEnvironmentAccessUrls(env, branch.app_url)[0]?.url;
  const commandActive = hasActiveEnvironmentCommand(env);
  const status = env?.status || 'stopped';
  const isRunning = status === 'running';
  const isStarting = status === 'starting';
  const isStopping = status === 'stopping';
  const canStop =
    status === 'running' || status === 'starting' || (status === 'error' && !!env?.command_attempt);
  return {
    env,
    effectiveEnv,
    hasConfig,
    environmentUrl,
    commandActive,
    status,
    isRunning,
    isStarting,
    isStopping,
    canStop,
    canOpenEnvironment: (isRunning || isStarting) && Boolean(environmentUrl),
    controlDisabledTooltip: canControlEnvironment ? undefined : ENVIRONMENT_NO_CONTROL,
    startDisabled:
      commandActive ||
      connectionDisabled ||
      !canControlEnvironment ||
      !hasConfig ||
      !canStart ||
      isStarting ||
      isStopping ||
      isRunning,
    stopDisabled:
      commandActive ||
      connectionDisabled ||
      !canControlEnvironment ||
      !hasConfig ||
      !canStopHandler ||
      isStopping ||
      !canStop,
  };
}
