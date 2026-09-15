/** Trusted source-runtime CLI only: DB authority and identifiers, never provider I/O or token reads. */
import {
  assertValidTenantId,
  beginManagedOAuthCellRetirement,
  createDatabase,
  type Database,
  getDatabaseUrl,
  listManagedOAuthMaintenanceTenants,
  MCPManagedOAuthOutboxRepository,
  readManagedOAuthCellRetirement,
  readManagedOAuthSchemaDigest,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import {
  isCanonicalFullUuid,
  type MCPManagedOAuthCellRetirementFence,
  type MCPManagedOAuthCellRetirementReport,
  type MCPManagedOAuthCellRetirementRequest,
  type MCPManagedOAuthRetirementReport,
  type MCPManagedOAuthRetirementRequest,
  type MCPManagedOAuthRetirementTargets,
  McpOAuthIdSchema,
} from '@agor/core/types';
import { Command, Flags } from '@oclif/core';
import {
  EXIT_FAILURE,
  EXIT_INVALID_INPUT,
  flushStderr,
  formatPortabilityError,
  writeStdoutJson,
} from './tenant-portability.js';

export function validateManagedRetirementRequest(input: MCPManagedOAuthRetirementRequest): void {
  assertValidTenantId(input.tenant_id);
  if (input.tenant_id.length > 1024) throw new Error('Invalid tenant identifier');
  if (!isCanonicalFullUuid(input.gate_generation)) throw new Error('Invalid gate generation');
  McpOAuthIdSchema.parse(input.operation_id);
}

export async function executeManagedRetirement(
  db: Database,
  input: MCPManagedOAuthRetirementRequest,
  retire: boolean
): Promise<MCPManagedOAuthRetirementReport> {
  validateManagedRetirementRequest(input);
  // Exact migrations/live catalog and real non-owner/NOBYPASSRLS role, not a version string.
  await runWithSystemDatabaseScope(db, 'managed lifecycle schema admission', (tx) =>
    readManagedOAuthSchemaDigest(tx)
  );
  const status = await runWithTenantDatabaseScope(db, input.tenant_id, async (tx) => {
    const repo = new MCPManagedOAuthOutboxRepository(tx);
    if (retire) await repo.retireTenantUnderWriteGate(input.tenant_id, input.gate_generation);
    return repo.getTenantRetirementStatus(input.tenant_id, input.gate_generation);
  });
  return { version: 1, ...input, ...status };
}

export async function listManagedRetirementTargets(
  db: Database,
  after?: string,
  limit = 100,
  fence?: MCPManagedOAuthCellRetirementFence,
  configuredCellId?: string
): Promise<MCPManagedOAuthRetirementTargets> {
  validateManagedRetirementTargets(after, limit, fence, configuredCellId);
  await runWithSystemDatabaseScope(db, 'managed lifecycle schema admission', (tx) =>
    readManagedOAuthSchemaDigest(tx)
  );
  const page = await runWithSystemDatabaseScope(
    db,
    'managed lifecycle routing identifiers',
    async (tx) => {
      if (
        fence &&
        !(await readManagedOAuthCellRetirement(
          tx,
          fence.cell_id,
          fence.operation_id,
          fence.gate_generation
        ))
      )
        throw new Error('Cell retirement barrier is missing');
      return listManagedOAuthMaintenanceTenants(tx, after, limit);
    },
    { capability: 'mcp_oauth_maintenance' }
  );
  return { version: 1, tenant_ids: page.tenantIds, next_after: page.nextCursor };
}

export function validateManagedRetirementTargets(
  after: string | undefined,
  limit: number,
  fence?: MCPManagedOAuthCellRetirementFence,
  configuredCellId?: string
): void {
  if (after !== undefined) {
    assertValidTenantId(after);
    if (after.length > 1024) throw new Error('Invalid cursor');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid page limit');
  if (fence) {
    validateManagedCellRetirementRequest(fence, configuredCellId);
    if (!isCanonicalFullUuid(fence.gate_generation))
      throw new Error('Invalid cell gate generation');
  }
}

export function validateManagedCellRetirementRequest(
  input: MCPManagedOAuthCellRetirementRequest,
  configuredCellId: string | undefined
): void {
  McpOAuthIdSchema.parse(input.cell_id);
  McpOAuthIdSchema.parse(input.operation_id);
  if (!configuredCellId || input.cell_id !== configuredCellId)
    throw new Error('Cell retirement requires the configured deployment identity');
}

export async function beginManagedCellRetirement(
  db: Database,
  input: MCPManagedOAuthCellRetirementRequest,
  configuredCellId: string | undefined
): Promise<MCPManagedOAuthCellRetirementReport> {
  validateManagedCellRetirementRequest(input, configuredCellId);
  await runWithSystemDatabaseScope(db, 'managed lifecycle schema admission', (tx) =>
    readManagedOAuthSchemaDigest(tx)
  );
  const result = await runWithSystemDatabaseScope(
    db,
    'permanent managed cell retirement',
    (tx) => beginManagedOAuthCellRetirement(tx, input.cell_id, input.operation_id),
    { capability: 'mcp_oauth_maintenance' }
  );
  return {
    version: 1,
    cell_id: result.cell_id,
    operation_id: result.operation_id,
    gate_generation: result.generation,
  };
}

/** Shared command implementation; subclasses choose mutation or read-only status, never a flag from Cloud. */
export class ManagedRetirementCommand extends Command {
  protected retire = false;
  static override flags = {
    'tenant-id': Flags.string({ required: true, description: 'Exact source tenant' }),
    'assert-gate-generation': Flags.string({
      required: true,
      description: 'Continuously held source write-gate generation',
    }),
    'operation-id': Flags.string({
      required: true,
      description: 'Bounded correlation identifier, not an authority credential',
    }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(ManagedRetirementCommand);
    const input = {
      tenant_id: flags['tenant-id'],
      gate_generation: flags['assert-gate-generation'],
      operation_id: flags['operation-id'],
    };
    try {
      validateManagedRetirementRequest(input);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      await flushStderr();
      process.exit(EXIT_INVALID_INPUT);
    }
    try {
      const result = await executeManagedRetirement(
        createDatabase({ url: getDatabaseUrl() }),
        input,
        this.retire
      );
      await writeStdoutJson(result);
      await flushStderr();
      process.exit(0);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      await flushStderr();
      process.exit(EXIT_FAILURE);
    }
  }
}
