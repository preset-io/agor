import type { KeyObject } from 'node:crypto';
import { applyTenantRestrictionIntent, type Database } from '@agor/core/db';
import type { TenantRestrictionCommand, TenantRestrictionRecord } from '@agor/core/types';
import { z } from 'zod';
import {
  type TenantRuntimeRestrictionCommandExpectations,
  type TenantRuntimeRestrictionCommandPayload,
  verifyTenantRuntimeRestrictionCommand,
} from './tenant-runtime-restriction-command.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$/;

const identifierSchema = (name: string) =>
  z.string().regex(IDENTIFIER_PATTERN, `${name} must be a non-empty bounded identifier`);
const databaseNameSchema = z
  .string()
  .regex(DATABASE_NAME_PATTERN, 'databaseName must be a non-empty bounded database name');
const placementOriginSchema = z
  .string()
  .url()
  .regex(
    /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/i,
    'placementOrigin must be a credential-free HTTP(S) URL without query or fragment'
  );

/**
 * Authoritative runtime-side tenant/Workspace binding supplied by the caller.
 *
 * The runtime currently has no durable Workspace catalog. Requiring this full
 * installation-bound record keeps that missing catalog an explicit dependency:
 * a caller that cannot resolve it must return null, not derive authority from a
 * request, URL, namespace, or Cloud projection.
 */
export const TenantRuntimeRestrictionTenantBindingSchema = z
  .object({
    workspaceId: identifierSchema('workspaceId'),
    tenantId: identifierSchema('tenantId'),
    teamId: identifierSchema('teamId'),
    deploymentId: z.string().regex(UUID_PATTERN, 'deploymentId must be a valid UUID'),
    databaseIncarnationId: identifierSchema('databaseIncarnationId'),
    databaseName: databaseNameSchema,
    logicalDatabaseId: identifierSchema('logicalDatabaseId'),
    placementId: identifierSchema('placementId'),
    placementOrigin: placementOriginSchema,
    placementRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type TenantRuntimeRestrictionTenantBinding = z.infer<
  typeof TenantRuntimeRestrictionTenantBindingSchema
>;

/** Only verified, immutable command data enters this resolver. */
export interface TenantRuntimeRestrictionTenantResolverInput {
  readonly tenantId: string;
  readonly command: Readonly<TenantRestrictionCommand>;
  readonly payload: Readonly<TenantRuntimeRestrictionCommandPayload>;
}

/**
 * Resolve the signed tenant to the authoritative runtime record. This is an
 * explicit fail-closed seam, not a fallback resolver. Implementations must use
 * a trusted runtime record and return null when the tenant is missing, moved,
 * or unresolved; they must not perform transport or wait for containment.
 */
export type TenantRuntimeRestrictionTenantResolver = (
  input: TenantRuntimeRestrictionTenantResolverInput
) =>
  | Promise<TenantRuntimeRestrictionTenantBinding | null>
  | TenantRuntimeRestrictionTenantBinding
  | null;

export interface ConsumeTenantRuntimeRestrictionCommandInput {
  readonly db: Database;
  readonly raw: unknown;
  readonly publicKey: string | KeyObject;
  readonly expectations: TenantRuntimeRestrictionCommandExpectations;
  readonly resolveTenant: TenantRuntimeRestrictionTenantResolver;
}

export type TenantRuntimeRestrictionConsumerErrorCode =
  | 'invalid_configuration'
  | 'tenant_binding_unavailable'
  | 'tenant_binding_mismatch';

export class TenantRuntimeRestrictionConsumerError extends Error {
  constructor(
    public readonly code: TenantRuntimeRestrictionConsumerErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'TenantRuntimeRestrictionConsumerError';
  }
}

/** `activate` is intentionally outside this bounded consumer slice. */
export class TenantRuntimeRestrictionUnsupportedError extends Error {
  readonly code = 'unsupported_action' as const;

  constructor(public readonly action: 'activate') {
    super('Tenant runtime restriction action is not supported by this consumer');
    this.name = 'TenantRuntimeRestrictionUnsupportedError';
  }
}

export interface TenantRuntimeRestrictionConsumption {
  /** Exact signer identity authenticated by the existing verifier. */
  readonly keyId: string;
  /** Exact signed tenant identity; never taken from the resolver or request. */
  readonly tenantId: string;
  /** Exact signed placement/team/database fields retained for the caller. */
  readonly payload: TenantRuntimeRestrictionCommandPayload;
  readonly command: TenantRestrictionCommand;
  readonly record: TenantRestrictionRecord;
  readonly changed: boolean;
}

function fail(
  code: TenantRuntimeRestrictionConsumerErrorCode,
  message: string,
  cause?: unknown
): never {
  throw new TenantRuntimeRestrictionConsumerError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function assertResolverConfigured(
  resolver: TenantRuntimeRestrictionTenantResolver
): asserts resolver is TenantRuntimeRestrictionTenantResolver {
  if (typeof resolver !== 'function') {
    fail('invalid_configuration', 'Tenant runtime restriction tenant resolver is required');
  }
}

function assertBindingMatchesCommand(
  binding: TenantRuntimeRestrictionTenantBinding,
  tenantId: string,
  payload: TenantRuntimeRestrictionCommandPayload
): void {
  if (
    binding.workspaceId !== tenantId ||
    binding.tenantId !== tenantId ||
    binding.teamId !== payload.team_id ||
    binding.deploymentId !== payload.deployment_id ||
    binding.databaseIncarnationId !== payload.database_incarnation_id ||
    binding.databaseName !== payload.database_name ||
    binding.logicalDatabaseId !== payload.logical_database_id ||
    binding.placementId !== payload.placement_id ||
    binding.placementOrigin !== payload.placement_origin ||
    binding.placementRevision !== payload.placement_revision
  ) {
    fail('tenant_binding_mismatch', 'Resolved tenant binding does not match the signed command');
  }
}

function immutableVerifiedCommand(
  verified: ReturnType<typeof verifyTenantRuntimeRestrictionCommand>
): ReturnType<typeof verifyTenantRuntimeRestrictionCommand> {
  // The resolver is injected, so do not give it mutable references that could
  // change the verified command before the persistence writer runs. All values
  // here are flat; shallow freezes cover the complete signed payload/command.
  const payload = Object.freeze({ ...verified.payload });
  const command = Object.freeze({ ...verified.command });
  return Object.freeze({
    keyId: verified.keyId,
    tenantId: verified.tenantId,
    payload,
    command,
  });
}

/**
 * Consume exactly one authenticated command through the existing durable
 * restriction writer. This is deliberately an unregistered internal seam:
 * there is no HTTP/MCP/socket/queue transport, worker, lease, scheduler,
 * containment observer, or completion/activation claim here.
 *
 * The writer owns the PostgreSQL tenant scope, tenant execution advisory fence,
 * controller fence, pure transition policy, and transaction rollback. No
 * result is returned until those exact durable checks have completed.
 */
export async function consumeTenantRuntimeRestrictionCommand(
  input: ConsumeTenantRuntimeRestrictionCommandInput
): Promise<TenantRuntimeRestrictionConsumption> {
  const verified = immutableVerifiedCommand(
    verifyTenantRuntimeRestrictionCommand(input.raw, input.publicKey, input.expectations)
  );
  assertResolverConfigured(input.resolveTenant);

  if (verified.command.action === 'activate') {
    throw new TenantRuntimeRestrictionUnsupportedError('activate');
  }

  let resolved: TenantRuntimeRestrictionTenantBinding | null;
  try {
    resolved = await input.resolveTenant({
      tenantId: verified.tenantId,
      command: verified.command,
      payload: verified.payload,
    });
  } catch (error) {
    fail(
      'tenant_binding_unavailable',
      'Authoritative runtime tenant binding is unavailable',
      error
    );
  }
  if (resolved === null || resolved === undefined) {
    fail('tenant_binding_unavailable', 'Authoritative runtime tenant binding is unavailable');
  }
  const parsed = TenantRuntimeRestrictionTenantBindingSchema.safeParse(resolved);
  if (!parsed.success) {
    fail(
      'tenant_binding_mismatch',
      'Authoritative runtime tenant binding is invalid',
      parsed.error
    );
  }
  assertBindingMatchesCommand(parsed.data, verified.tenantId, verified.payload);

  // Do not catch this call: the existing writer's typed transition/DB errors
  // must escape and its transaction must remain the only mutation boundary.
  const applied = await applyTenantRestrictionIntent(input.db, verified.tenantId, verified.command);
  return {
    keyId: verified.keyId,
    tenantId: verified.tenantId,
    payload: verified.payload,
    command: verified.command,
    record: applied.record,
    changed: applied.changed,
  };
}
