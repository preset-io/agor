import {
  BranchRepository,
  EnvironmentCommandRepository,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { decodeEnvironmentLifecycleResult } from '@agor/core/environment/lifecycle-result';
import { type Application, BadRequest, Forbidden } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  ENVIRONMENT_COMMAND_ACTIONS,
  ENVIRONMENT_COMMAND_BUDGET,
  type EnvironmentCommandReport,
  environmentCommandTokenId,
  type UserID,
} from '@agor/core/types';
import { z } from 'zod';
import { matchesExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
import { ensureCanControlBranchEnvironment } from '../utils/branch-authorization.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';

const output = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= ENVIRONMENT_COMMAND_BUDGET.outputBytes,
    'Command output exceeds byte limit'
  );
const scope = z.object({
  branch_id: z.string().uuid(),
  attempt_id: z.string().uuid(),
  action: z.enum(ENVIRONMENT_COMMAND_ACTIONS),
});
const reportSchema = z.discriminatedUnion('kind', [
  scope.extend({ kind: z.literal('claim') }).strict(),
  scope
    .extend({
      kind: z.literal('output'),
      sequence: z.number().int().positive().max(10000),
      output,
      truncated: z.boolean(),
    })
    .strict(),
  scope
    .extend({
      kind: z.literal('result'),
      outcome: z.enum(['succeeded', 'failed', 'unknown']),
      output: output.optional(),
      truncated: z.boolean().optional(),
      message: z.string().max(1024),
      lifecycle_result: z.unknown().optional(),
      /** Upgrade-only shape emitted by executors using the former result file. */
      access_urls: z.unknown().optional(),
    })
    .strict(),
]);

/** Executor-initiated, attempt-scoped reporting. No response reservation or replica owner. */
export class EnvironmentCommandReportsService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application
  ) {}

  async create(data: unknown, params?: AuthenticatedParams) {
    const parsed = reportSchema.safeParse(data);
    if (!parsed.success) throw new BadRequest('Invalid or oversized environment command report');
    const rawReport = parsed.data;
    let report = rawReport as EnvironmentCommandReport;
    if (
      rawReport.kind === 'result' &&
      (rawReport.lifecycle_result !== undefined || rawReport.access_urls !== undefined)
    ) {
      if (
        rawReport.action !== 'start' ||
        (rawReport.lifecycle_result !== undefined && rawReport.access_urls !== undefined)
      ) {
        throw new BadRequest('Invalid or oversized environment command report');
      }
      try {
        const { access_urls: legacyAccessUrls, ...canonical } = rawReport;
        report = {
          ...canonical,
          lifecycle_result: decodeEnvironmentLifecycleResult(
            rawReport.lifecycle_result ?? { access_urls: legacyAccessUrls }
          ),
        } as EnvironmentCommandReport;
      } catch {
        throw new BadRequest('Invalid or oversized environment command report');
      }
    }
    if (
      !params?.provider ||
      !params.user ||
      !matchesExecutorCommandRuntimeScope(
        params,
        environmentCommandTokenId(report.action, report.attempt_id),
        report.branch_id
      )
    ) {
      throw new Forbidden(
        'An executor credential scoped to this branch, action, and attempt is required'
      );
    }
    const tenantId = requireCurrentTenantId();
    if (
      params.tenant?.tenant_id !== tenantId ||
      params.authentication?.payload?.tenant_id !== tenantId
    ) {
      throw new Forbidden(
        'Environment command credential and request must match the current tenant'
      );
    }
    const expectedRequester = params.user.user_id as UserID;
    return runWithTenantDatabaseScope(this.db, tenantId, async (scoped) => {
      const branches = new BranchRepository(scoped);
      if (report.kind === 'claim') {
        await ensureCanControlBranchEnvironment(
          branches,
          report.branch_id,
          params,
          'claim an environment command'
        );
      }
      // Claim checks current permission. Later progress/result reports carry no
      // new authority: the exact token and persisted initiating actor may only
      // settle the already-authorized attempt, even after permission revocation.
      const environment = await new EnvironmentCommandRepository(scoped).report(report, {
        expectedRequester,
      });
      const branch = await branches.findById(report.branch_id);
      if (branch)
        emitServiceEvent(this.app, {
          path: 'branches',
          event: 'patched',
          data: branch,
          params,
          id: report.branch_id,
        });
      return {
        command_deadline: environment.command_attempt!.command_deadline,
        result_deadline: environment.command_attempt!.result_deadline,
      };
    });
  }
}
