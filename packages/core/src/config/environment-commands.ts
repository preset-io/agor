import { EXECUTOR_RESPONSE_PROTOCOL } from '../executor-protocol';
import { ENVIRONMENT_COMMAND_BUDGET as BUDGET } from '../types/environment-command';
import type { AgorConfig } from './types';

/** No provider/SHA gate: this is an operator assertion about the trusted launcher. */
export function usesAsyncEnvironmentCommands(config: AgorConfig): boolean {
  return (
    config.deployment?.mode === 'ha' &&
    config.execution?.managed_envs_execution_mode !== 'webhook-only'
  );
}

export function assertAsyncEnvironmentCommandConfig(config: AgorConfig): void {
  if (!usesAsyncEnvironmentCommands(config)) return;
  if (
    config.deployment?.ha?.execution_topology !== 'external' ||
    config.execution?.unix_user_mode !== 'delegated' ||
    !config.execution.executor_command_template?.trim()
  ) {
    throw new Error(
      'HA hybrid environments require external delegated execution; daemon-local HA shell commands are unsupported'
    );
  }
  const deadline = config.execution.environment_command_job_deadline_ms;
  if (
    !Number.isSafeInteger(deadline) ||
    deadline! < BUDGET.commandMs + BUDGET.cleanupMs ||
    deadline! > BUDGET.claimMs + BUDGET.commandMs + BUDGET.cleanupMs
  ) {
    throw new Error(
      'HA hybrid environments require execution.environment_command_job_deadline_ms between 305000 and 365000, matching the external Job deadline INCLUDING termination grace'
    );
  }
  if (
    (config.execution.session_token_expiration_ms ?? 86_400_000) <
    BUDGET.claimMs + BUDGET.commandMs + BUDGET.cleanupMs + BUDGET.reportMs + BUDGET.launchMs
  ) {
    throw new Error(
      'Environment command credentials must outlive launch, claim, execution, cleanup, and report budgets (at least 405000ms)'
    );
  }
}

export function environmentCommandCapabilities(config: AgorConfig) {
  const external = !!config.execution?.executor_command_template?.trim();
  const response = config.execution?.executor_response;
  const shellLogs =
    !external ||
    (response?.external_protocol === EXECUTOR_RESPONSE_PROTOCOL && !!response.origin_url);
  return {
    asynchronous: usesAsyncEnvironmentCommands(config),
    shellLogs,
    ...(shellLogs
      ? {}
      : {
          shellLogsReason:
            'Shell Logs requires executor-response-v1 and an exact replica origin_url. Lifecycle commands and their reported output do not.',
        }),
  };
}
