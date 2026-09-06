import {
  BranchRepository,
  EnvironmentCommandRepository,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, Forbidden } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  ENVIRONMENT_COMMAND_ACTIONS,
  ENVIRONMENT_COMMAND_BUDGET,
  type EnvironmentCommandReport,
  environmentCommandTokenId,
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
      access_urls: z
        .array(
          z
            .object({
              name: z.string().min(1).max(128),
              url: z
                .string()
                .max(2048)
                .refine((value) => {
                  try {
                    const url = new URL(value);
                    return (
                      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
                    );
                  } catch {
                    return false;
                  }
                }, 'Access URLs must be absolute credential-free HTTP(S) URLs'),
            })
            .strict()
        )
        .max(8)
        .optional(),
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
    const report = parsed.data as EnvironmentCommandReport;
    if (
      !params?.provider ||
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
    return runWithTenantDatabaseScope(this.db, tenantId, async (scoped) => {
      const branches = new BranchRepository(scoped);
      await ensureCanControlBranchEnvironment(
        branches,
        report.branch_id,
        params,
        'report an environment command'
      );
      const environment = await new EnvironmentCommandRepository(scoped).report(report);
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
