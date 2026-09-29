import { ENVIRONMENT_COMMAND_BUDGET } from '../types/environment-command';

/** One bounded source update. HA keeps the existing external command envelope. */
export function environmentSyncCommandBudget(asynchronous: boolean): number {
  return asynchronous ? ENVIRONMENT_COMMAND_BUDGET.commandMs : 20 * 60_000;
}

export function environmentSyncBudget(commandTimeoutMs: number) {
  if (
    !Number.isSafeInteger(commandTimeoutMs) ||
    commandTimeoutMs < 1_000 ||
    commandTimeoutMs > environmentSyncCommandBudget(false)
  ) {
    throw new Error('Invalid environment sync command budget');
  }
  const credentialLifetimeMs =
    ENVIRONMENT_COMMAND_BUDGET.launchMs +
    ENVIRONMENT_COMMAND_BUDGET.claimMs +
    commandTimeoutMs +
    ENVIRONMENT_COMMAND_BUDGET.cleanupMs +
    ENVIRONMENT_COMMAND_BUDGET.reportMs;
  return {
    commandTimeoutMs,
    credentialLifetimeMs,
    requestTimeoutMs: credentialLifetimeMs,
    claimLeaseMs: credentialLifetimeMs + ENVIRONMENT_COMMAND_BUDGET.reportMs,
  };
}
