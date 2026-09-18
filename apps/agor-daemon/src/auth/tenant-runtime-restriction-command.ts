import { createPublicKey, type KeyObject, verify as verifySignature } from 'node:crypto';
import { type TenantRestrictionCommand, TenantRestrictionCommandSchema } from '@agor/core/types';
import { z } from 'zod';
import type { TenantRuntimeBootstrapPayload } from './tenant-runtime-bootstrap.js';
import type { TenantRuntimeCurrentAuthority } from './tenant-runtime-current-authority.js';

/** Signed command envelope accepted by a future privileged runtime adapter. */
export const TENANT_RUNTIME_RESTRICTION_COMMAND_KIND =
  'agor.tenant-runtime-restriction-command' as const;
export const TENANT_RUNTIME_RESTRICTION_COMMAND_VERSION = 1 as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]+$/;

const identifierSchema = (name: string) =>
  z.string().regex(IDENTIFIER_PATTERN, `${name} must be a non-empty bounded identifier`);
const databaseNameSchema = z
  .string()
  .regex(DATABASE_NAME_PATTERN, 'database_name must be a non-empty bounded database name');
const placementOriginSchema = z
  .string()
  .url()
  .regex(
    /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/i,
    'placement_origin must be a credential-free HTTP(S) URL without query or fragment'
  );

const payloadSchema = z
  .object({
    kind: z.literal(TENANT_RUNTIME_RESTRICTION_COMMAND_KIND),
    version: z.literal(TENANT_RUNTIME_RESTRICTION_COMMAND_VERSION),
    tenant_id: identifierSchema('tenant_id'),
    deployment_id: z.string().regex(UUID_PATTERN, 'deployment_id must be a valid UUID'),
    database_incarnation_id: identifierSchema('database_incarnation_id'),
    database_name: databaseNameSchema,
    logical_database_id: identifierSchema('logical_database_id'),
    team_id: identifierSchema('team_id'),
    placement_id: identifierSchema('placement_id'),
    placement_origin: placementOriginSchema,
    placement_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    controller_id: identifierSchema('controller_id'),
    operation_id: identifierSchema('operation_id'),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    action: z.enum(['restrict', 'prepare_release', 'activate']),
    // Commands have no expiry. A durable restriction must survive a delayed
    // delivery; operation/revision watermarks provide the replay fence.
    issued_at: z.string().datetime({ offset: true }),
  })
  .strict();

const signedEnvelopeSchema = z
  .object({
    key_id: identifierSchema('key_id'),
    payload: payloadSchema,
    signature: z.string().regex(SIGNATURE_PATTERN, 'signature must be base64url'),
  })
  .strict();

export type TenantRuntimeRestrictionCommandPayload = z.infer<typeof payloadSchema>;
export type SignedTenantRuntimeRestrictionCommand = z.infer<typeof signedEnvelopeSchema>;

export interface TenantRuntimeRestrictionCommandExpectations {
  /** Signed bootstrap from the same managed placement. */
  readonly bootstrap: TenantRuntimeBootstrapPayload;
  /** Read/lock-only identity returned by the connected database adapter. */
  readonly currentAuthority: TenantRuntimeCurrentAuthority;
  /** Independently configured public-key identity. */
  readonly expectedKeyId: string;
  /** Independently configured controller identity; never chosen by the request. */
  readonly expectedControllerId: string;
}

export type TenantRuntimeRestrictionCommandErrorCode =
  | 'invalid_document'
  | 'invalid_configuration'
  | 'signature_invalid'
  | 'binding_mismatch';

export class TenantRuntimeRestrictionCommandError extends Error {
  constructor(
    public readonly code: TenantRuntimeRestrictionCommandErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'TenantRuntimeRestrictionCommandError';
  }
}

function fail(
  code: TenantRuntimeRestrictionCommandErrorCode,
  message: string,
  cause?: unknown
): never {
  throw new TenantRuntimeRestrictionCommandError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function resolvePublicKey(input: string | KeyObject): KeyObject {
  try {
    const key = typeof input === 'string' ? createPublicKey(input) : input;
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      fail('invalid_configuration', 'Tenant runtime command key must be an Ed25519 public key');
    }
    return key;
  } catch (error) {
    if (error instanceof TenantRuntimeRestrictionCommandError) throw error;
    fail('invalid_configuration', 'Tenant runtime command public key is invalid', error);
  }
}

function parseEnvelope(raw: unknown): SignedTenantRuntimeRestrictionCommand {
  const parsed = signedEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    fail('invalid_document', 'Tenant runtime restriction command is invalid', parsed.error);
  }
  return parsed.data;
}

/** Stable JSON form covered by the detached Ed25519 signature. */
export function canonicalizeSignedTenantRuntimeRestrictionCommand(
  keyId: string,
  payload: TenantRuntimeRestrictionCommandPayload
): string {
  return JSON.stringify({
    key_id: keyId,
    payload: {
      action: payload.action,
      controller_id: payload.controller_id,
      database_incarnation_id: payload.database_incarnation_id,
      database_name: payload.database_name,
      deployment_id: payload.deployment_id,
      issued_at: payload.issued_at,
      kind: payload.kind,
      logical_database_id: payload.logical_database_id,
      operation_id: payload.operation_id,
      placement_id: payload.placement_id,
      placement_origin: payload.placement_origin,
      placement_revision: payload.placement_revision,
      revision: payload.revision,
      team_id: payload.team_id,
      tenant_id: payload.tenant_id,
      version: payload.version,
    },
  });
}

function assertConfiguration(expectations: TenantRuntimeRestrictionCommandExpectations): void {
  if (
    typeof expectations.expectedKeyId !== 'string' ||
    !expectations.expectedKeyId ||
    expectations.expectedKeyId.trim() !== expectations.expectedKeyId
  ) {
    fail('invalid_configuration', 'expectedKeyId must be a non-empty trimmed identifier');
  }
  if (
    typeof expectations.expectedControllerId !== 'string' ||
    !expectations.expectedControllerId ||
    expectations.expectedControllerId.trim() !== expectations.expectedControllerId ||
    !IDENTIFIER_PATTERN.test(expectations.expectedKeyId) ||
    !IDENTIFIER_PATTERN.test(expectations.expectedControllerId)
  ) {
    fail('invalid_configuration', 'Runtime command identity configuration is invalid');
  }
}

function assertAuthorityMatchesBootstrap(
  authority: TenantRuntimeCurrentAuthority,
  bootstrap: TenantRuntimeBootstrapPayload
): void {
  if (authority.identityKey !== 'primary' || authority.protocolVersion !== 1) {
    fail('binding_mismatch', 'Current runtime authority protocol or key is invalid');
  }
  const checks: Array<[string, string, string]> = [
    ['deployment identity', authority.deploymentId, bootstrap.deployment_id],
    ['database incarnation', authority.databaseIncarnationId, bootstrap.database_incarnation_id],
    ['database name', authority.databaseName, bootstrap.database_name],
    ['logical database identity', authority.logicalDatabaseId, bootstrap.logical_database_id],
    ['team identity', authority.teamId, bootstrap.team_id],
    ['placement identity', authority.placementId, bootstrap.placement_id],
    ['placement origin', authority.placementOrigin, bootstrap.placement_origin],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) {
      fail('binding_mismatch', `Current runtime authority does not match bootstrap ${label}`);
    }
  }
  if (authority.placementRevision !== bootstrap.placement_revision) {
    fail(
      'binding_mismatch',
      'Current runtime authority does not match bootstrap placement revision'
    );
  }
}

function assertPayloadMatchesInstallation(
  payload: TenantRuntimeRestrictionCommandPayload,
  bootstrap: TenantRuntimeBootstrapPayload,
  authority: TenantRuntimeCurrentAuthority
): void {
  const checks: Array<[string, string, string]> = [
    ['deployment identity', payload.deployment_id, bootstrap.deployment_id],
    ['database incarnation', payload.database_incarnation_id, bootstrap.database_incarnation_id],
    ['database name', payload.database_name, bootstrap.database_name],
    ['logical database identity', payload.logical_database_id, bootstrap.logical_database_id],
    ['team identity', payload.team_id, bootstrap.team_id],
    ['placement identity', payload.placement_id, bootstrap.placement_id],
    ['placement origin', payload.placement_origin, bootstrap.placement_origin],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) {
      fail('binding_mismatch', `Runtime command does not match installation ${label}`);
    }
  }
  if (
    payload.placement_revision !== bootstrap.placement_revision ||
    payload.placement_revision !== authority.placementRevision
  ) {
    fail('binding_mismatch', 'Runtime command placement revision does not match installation');
  }
}

/**
 * Verify a signed command without changing runtime state. The signed
 * `tenant_id` is authenticated but is not thereby proven to belong to this
 * installation or a live Workspace. A future authenticated coordinator must
 * bind it authoritatively, revalidate the target inside the persistence
 * transaction, and then invoke the PostgreSQL transition under the returned
 * command. This verifier deliberately performs neither lookup nor mutation;
 * it also does not establish current freshness or consume replayed revisions.
 */
export function verifyTenantRuntimeRestrictionCommand(
  raw: unknown,
  publicKeyInput: string | KeyObject,
  expectations: TenantRuntimeRestrictionCommandExpectations
): {
  keyId: string;
  tenantId: string;
  payload: TenantRuntimeRestrictionCommandPayload;
  command: TenantRestrictionCommand;
} {
  assertConfiguration(expectations);
  const signed = parseEnvelope(raw);
  if (signed.key_id !== expectations.expectedKeyId) {
    fail('binding_mismatch', 'Runtime command signing key is not the configured key');
  }
  if (signed.payload.controller_id !== expectations.expectedControllerId) {
    fail('binding_mismatch', 'Runtime command controller is not the configured controller');
  }
  const publicKey = resolvePublicKey(publicKeyInput);
  const signature = Buffer.from(signed.signature, 'base64url');
  if (signature.length !== 64) {
    fail('signature_invalid', 'Runtime command signature has an invalid length');
  }
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(
        canonicalizeSignedTenantRuntimeRestrictionCommand(signed.key_id, signed.payload),
        'utf8'
      ),
      publicKey,
      signature
    );
  } catch (error) {
    fail('signature_invalid', 'Runtime command signature could not be verified', error);
  }
  if (!valid) fail('signature_invalid', 'Runtime command signature is invalid');
  assertAuthorityMatchesBootstrap(expectations.currentAuthority, expectations.bootstrap);
  assertPayloadMatchesInstallation(
    signed.payload,
    expectations.bootstrap,
    expectations.currentAuthority
  );
  return {
    keyId: signed.key_id,
    tenantId: signed.payload.tenant_id,
    payload: signed.payload,
    command: TenantRestrictionCommandSchema.parse({
      version: 1,
      controllerId: signed.payload.controller_id,
      placementId: signed.payload.placement_id,
      operationId: signed.payload.operation_id,
      revision: signed.payload.revision,
      action: signed.payload.action,
    }),
  };
}
