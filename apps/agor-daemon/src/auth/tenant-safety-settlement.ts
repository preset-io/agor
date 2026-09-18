import type { HookContext } from '@agor/core/types';
import {
  BRANCH_CLEANUP_REPORT_SERVICE,
  BRANCH_DELETION_REPORT_SERVICE,
  branchCleanupCommandId,
  branchDeletionCommandId,
  ENVIRONMENT_COMMAND_REPORT_SERVICE,
  environmentCommandTokenId,
} from '@agor/core/types';
import {
  matchesExecutorCommandRuntimeScope,
  requireTaskScopedExecutorRuntimeToken,
} from './executor-runtime-scope.js';

/**
 * Authenticate exact lifecycle capabilities BEFORE treating a request as safety
 * traffic. Service schemas and durable operation/generation checks still run.
 * This grants no general read, start, claim, role or provider exemption.
 */
export async function isTenantSafetySettlement(context: HookContext): Promise<boolean> {
  if (
    context.path === 'tasks' &&
    [
      'getTerminationState',
      'reportTerminationComplete',
      'reportRuntimeTelemetry',
      'reportSdkHealthFailure',
    ].includes(context.method)
  ) {
    await requireTaskScopedExecutorRuntimeToken()(context);
    return true;
  }
  if (context.method !== 'create' || !context.params.provider) return false;
  const data = context.data as Record<string, unknown> | undefined;
  if (!data || typeof data.branch_id !== 'string') return false;
  const params = context.params;
  if (context.path === ENVIRONMENT_COMMAND_REPORT_SERVICE && typeof data.attempt_id === 'string') {
    if (data.action !== 'start' && data.action !== 'stop' && data.action !== 'nuke') return false;
    if (
      data.kind !== 'output' &&
      data.kind !== 'result' &&
      !(data.kind === 'claim' && data.action === 'stop')
    )
      return false;
    return matchesExecutorCommandRuntimeScope(
      params,
      environmentCommandTokenId(data.action, data.attempt_id),
      data.branch_id
    );
  }
  if (typeof data.execution_id !== 'string') return false;
  if (
    context.path === BRANCH_CLEANUP_REPORT_SERVICE &&
    ['succeeded', 'failed', 'unknown'].includes(String(data.action))
  ) {
    return matchesExecutorCommandRuntimeScope(
      params,
      branchCleanupCommandId(data.execution_id),
      data.branch_id
    );
  }
  if (
    context.path === BRANCH_DELETION_REPORT_SERVICE &&
    ['heartbeat', 'quiesce', 'upload', 'storage', 'data', 'finalize', 'failed'].includes(
      String(data.action)
    )
  ) {
    return matchesExecutorCommandRuntimeScope(
      params,
      branchDeletionCommandId(data.execution_id),
      data.branch_id
    );
  }
  return false;
}
