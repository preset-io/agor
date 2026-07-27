import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchID } from '@agor/core/types';
import {
  generateSessionToken,
  getDaemonUrl,
  runExecutorCommand,
  serviceTokenScopeForParams,
} from './spawn-executor.js';

export interface BranchInspectResult {
  currentSha: string;
  currentRef: string;
}

function isBranchInspectResult(value: unknown): value is BranchInspectResult {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as BranchInspectResult).currentSha === 'string' &&
    typeof (value as BranchInspectResult).currentRef === 'string'
  );
}

export async function inspectBranchViaExecutor(
  app: Application,
  branchId: BranchID,
  options: {
    asUser?: string | null;
    logPrefix?: string;
    /** Authenticated request params; used for token scope and template substitution. */
    params?: Partial<AuthenticatedParams>;
  } = {}
): Promise<BranchInspectResult> {
  const sessionToken = generateSessionToken(
    app as unknown as { settings: { authentication?: { secret?: string } } },
    serviceTokenScopeForParams(options.params)
  );

  const result = await runExecutorCommand(
    {
      command: 'branch.inspect',
      sessionToken,
      daemonUrl: getDaemonUrl(),
      params: { branchId },
    },
    {
      logPrefix: options.logPrefix ?? `[branch.inspect ${branchId}]`,
      asUser: options.asUser ?? undefined,
      params: options.params,
    }
  );

  if (!result.success) {
    throw new Error(result.error?.message ?? `branch.inspect failed for ${branchId}`);
  }

  if (!isBranchInspectResult(result.data)) {
    throw new Error(`branch.inspect returned an invalid result for ${branchId}`);
  }

  return result.data;
}
