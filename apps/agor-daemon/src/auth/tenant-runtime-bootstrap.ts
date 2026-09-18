import { createPublicKey, type KeyObject, verify as verifySignature } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * Signed placement/bootstrap contract for a managed runtime.
 *
 * This is deliberately a verification-only boundary. The runtime never
 * creates, registers, or repairs an installation identity here. A deployment
 * controller must issue the document and provide the independently-supplied
 * expected values through its bootstrap environment. v1 is single-team
 * scoped; auth-resolved/shared runtimes must use a future installation-wide
 * identity plus separately scoped tenant placement claims.
 */
export const TENANT_RUNTIME_BOOTSTRAP_VERSION = 1 as const;
export const TENANT_RUNTIME_BOOTSTRAP_KIND = 'agor.tenant-runtime-bootstrap' as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_REPLICA_INVENTORY = 256;

function identifierSchema(name: string) {
  return z.string().regex(IDENTIFIER_PATTERN, `${name} must be a non-empty bounded identifier`);
}

const databaseNameSchema = z
  .string()
  .regex(DATABASE_NAME_PATTERN, 'database_name must be a non-empty bounded database name');

const replicaSchema = z
  .object({
    replica_id: identifierSchema('replica_id'),
    incarnation_id: identifierSchema('incarnation_id'),
  })
  .strict();

const bootstrapPayloadSchema = z
  .object({
    kind: z.literal(TENANT_RUNTIME_BOOTSTRAP_KIND),
    version: z.literal(TENANT_RUNTIME_BOOTSTRAP_VERSION),
    deployment_id: z.string().regex(UUID_PATTERN, 'deployment_id must be a valid UUID'),
    database_incarnation_id: identifierSchema('database_incarnation_id'),
    database_name: databaseNameSchema,
    logical_database_id: identifierSchema('logical_database_id'),
    team_id: identifierSchema('team_id'),
    placement_id: identifierSchema('placement_id'),
    placement_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    placement_origin: z.string().url(),
    replica_inventory: z.array(replicaSchema).min(1).max(MAX_REPLICA_INVENTORY),
    /** Restores are intentionally not accepted by this v1 contract. */
    restore_policy: z.literal('closed'),
    issued_at: z.string().datetime({ offset: true }),
  })
  .strict();

const signedBootstrapSchema = z
  .object({
    key_id: identifierSchema('key_id'),
    payload: bootstrapPayloadSchema,
    signature: z.string().regex(SIGNATURE_PATTERN, 'signature must be base64url'),
  })
  .strict();

export type TenantRuntimeBootstrapPayload = z.infer<typeof bootstrapPayloadSchema>;
export type SignedTenantRuntimeBootstrap = z.infer<typeof signedBootstrapSchema>;

export interface TenantRuntimeBootstrapExpectations {
  /** Config-local identity. This must also match expectedDeploymentId. */
  readonly deploymentId: string;
  /** Independently supplied by the deployment; never read from the copied DB. */
  readonly expectedDeploymentId: string;
  /** Independently supplied database-incarnation identity. */
  readonly databaseIncarnationId: string;
  /** Replica identity supplied by the managed deployment, not HOSTNAME fallback. */
  readonly currentReplica: {
    readonly replicaId: string;
    readonly incarnationId: string;
  };
  readonly expectedKeyId: string;
  readonly expectedTeamId?: string;
  readonly expectedPlacementId?: string;
  readonly expectedPlacementRevision?: number;
}

export interface TenantRuntimeBootstrapEnvironment {
  readonly AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED?: string;
  readonly AGOR_TENANT_RUNTIME_BOOTSTRAP_PATH?: string;
  readonly AGOR_TENANT_RUNTIME_BOOTSTRAP_PUBLIC_KEY?: string;
  readonly AGOR_TENANT_RUNTIME_BOOTSTRAP_PUBLIC_KEY_PATH?: string;
  readonly AGOR_TENANT_RUNTIME_BOOTSTRAP_KEY_ID?: string;
  readonly AGOR_TENANT_RUNTIME_EXPECTED_DEPLOYMENT_ID?: string;
  readonly AGOR_TENANT_RUNTIME_DATABASE_INCARNATION_ID?: string;
  readonly AGOR_DAEMON_INSTANCE_ID?: string;
  readonly AGOR_TENANT_RUNTIME_REPLICA_INCARNATION_ID?: string;
  readonly AGOR_TENANT_RUNTIME_EXPECTED_TEAM_ID?: string;
  readonly AGOR_TENANT_RUNTIME_EXPECTED_PLACEMENT_ID?: string;
  readonly AGOR_TENANT_RUNTIME_EXPECTED_PLACEMENT_REVISION?: string;
}

export type TenantRuntimeBootstrapErrorCode =
  | 'invalid_document'
  | 'invalid_configuration'
  | 'signature_invalid'
  | 'binding_mismatch';

export class TenantRuntimeBootstrapError extends Error {
  constructor(
    public readonly code: TenantRuntimeBootstrapErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'TenantRuntimeBootstrapError';
  }
}

function fail(code: TenantRuntimeBootstrapErrorCode, message: string, cause?: unknown): never {
  throw new TenantRuntimeBootstrapError(code, message, cause === undefined ? undefined : { cause });
}

function normalizedEnvironmentValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function compareIdentifiers(a: string, b: string): number {
  // IDs are restricted to ASCII. Relational comparison gives a stable
  // UTF-16/code-unit order independent of the host locale.
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseRequiredBoolean(value: string | undefined): boolean | undefined {
  const normalized = normalizedEnvironmentValue(value)?.toLowerCase();
  if (normalized === undefined) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  fail('invalid_configuration', 'AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED must be a boolean value');
}

function parseDocument(raw: unknown): SignedTenantRuntimeBootstrap {
  const parsed = signedBootstrapSchema.safeParse(raw);
  if (!parsed.success) {
    fail('invalid_document', 'Tenant runtime bootstrap document is invalid', parsed.error);
  }
  const replicas = parsed.data.payload.replica_inventory;
  const replicaIds = replicas.map((replica) => replica.replica_id);
  if (new Set(replicaIds).size !== replicaIds.length) {
    fail('invalid_document', 'Tenant runtime bootstrap contains duplicate replica IDs');
  }
  for (let index = 1; index < replicas.length; index += 1) {
    if (compareIdentifiers(replicas[index - 1]!.replica_id, replicas[index]!.replica_id) >= 0) {
      fail(
        'invalid_document',
        'Tenant runtime bootstrap replica_inventory must be sorted by replica_id'
      );
    }
  }

  const origin = new URL(parsed.data.payload.placement_origin);
  if (
    (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    fail(
      'invalid_document',
      'Tenant runtime bootstrap placement_origin must be a credential-free HTTP(S) URL without query or fragment'
    );
  }
  return parsed.data;
}

/** Stable JSON form signed by the Cloud/deployment controller. */
function canonicalPayloadObject(payload: TenantRuntimeBootstrapPayload) {
  return {
    database_incarnation_id: payload.database_incarnation_id,
    database_name: payload.database_name,
    deployment_id: payload.deployment_id,
    issued_at: payload.issued_at,
    kind: payload.kind,
    logical_database_id: payload.logical_database_id,
    placement_id: payload.placement_id,
    placement_origin: payload.placement_origin,
    placement_revision: payload.placement_revision,
    replica_inventory: payload.replica_inventory.map((replica) => ({
      incarnation_id: replica.incarnation_id,
      replica_id: replica.replica_id,
    })),
    restore_policy: payload.restore_policy,
    team_id: payload.team_id,
    version: payload.version,
  };
}

/** Stable JSON form for the payload alone, useful when composing an envelope. */
export function canonicalizeTenantRuntimeBootstrapPayload(
  payload: TenantRuntimeBootstrapPayload
): string {
  return JSON.stringify(canonicalPayloadObject(payload));
}

/** Stable JSON form covered by the detached Ed25519 signature. */
export function canonicalizeSignedTenantRuntimeBootstrap(
  keyId: string,
  payload: TenantRuntimeBootstrapPayload
): string {
  return JSON.stringify({ key_id: keyId, payload: canonicalPayloadObject(payload) });
}

function resolvePublicKey(input: string | KeyObject): KeyObject {
  try {
    const key = typeof input === 'string' ? createPublicKey(input) : input;
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      fail('invalid_configuration', 'Tenant runtime bootstrap key must be an Ed25519 public key');
    }
    return key;
  } catch (error) {
    if (error instanceof TenantRuntimeBootstrapError) throw error;
    fail('invalid_configuration', 'Tenant runtime bootstrap public key is invalid', error);
  }
}

function assertExpectedIdentifier(value: string, name: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    fail('invalid_configuration', `${name} must be a non-empty bounded identifier`);
  }
}

function assertBinding(
  payload: TenantRuntimeBootstrapPayload,
  expectations: TenantRuntimeBootstrapExpectations
): void {
  if (
    !UUID_PATTERN.test(expectations.deploymentId) ||
    !UUID_PATTERN.test(expectations.expectedDeploymentId)
  ) {
    fail('invalid_configuration', 'Runtime deployment identity must be a valid UUID');
  }
  if (expectations.deploymentId !== expectations.expectedDeploymentId) {
    fail(
      'binding_mismatch',
      'Runtime deployment identity does not match the independently supplied deployment identity'
    );
  }
  assertExpectedIdentifier(expectations.databaseIncarnationId, 'databaseIncarnationId');
  assertExpectedIdentifier(expectations.currentReplica.replicaId, 'currentReplica.replicaId');
  assertExpectedIdentifier(
    expectations.currentReplica.incarnationId,
    'currentReplica.incarnationId'
  );
  assertExpectedIdentifier(expectations.expectedKeyId, 'expectedKeyId');
  if (payload.deployment_id !== expectations.deploymentId) {
    fail('binding_mismatch', 'Bootstrap deployment identity does not match this runtime');
  }
  if (payload.database_incarnation_id !== expectations.databaseIncarnationId) {
    fail('binding_mismatch', 'Bootstrap database incarnation does not match this runtime');
  }
  if (expectations.expectedKeyId !== expectations.expectedKeyId.trim()) {
    fail('invalid_configuration', 'expectedKeyId must not contain surrounding whitespace');
  }
  if (
    expectations.expectedTeamId !== undefined &&
    payload.team_id !== expectations.expectedTeamId
  ) {
    fail('binding_mismatch', 'Bootstrap team identity does not match this runtime');
  }
  if (
    expectations.expectedPlacementId !== undefined &&
    payload.placement_id !== expectations.expectedPlacementId
  ) {
    fail('binding_mismatch', 'Bootstrap placement identity does not match this runtime');
  }
  if (
    expectations.expectedPlacementRevision !== undefined &&
    payload.placement_revision !== expectations.expectedPlacementRevision
  ) {
    fail('binding_mismatch', 'Bootstrap placement revision does not match this runtime');
  }
  const current = payload.replica_inventory.find(
    (replica) => replica.replica_id === expectations.currentReplica.replicaId
  );
  if (!current || current.incarnation_id !== expectations.currentReplica.incarnationId) {
    fail('binding_mismatch', 'Current replica is not present at the expected incarnation');
  }
}

/** Verify a signed bootstrap without mutating durable state or registering anything. */
export function verifyTenantRuntimeBootstrap(
  raw: unknown,
  publicKeyInput: string | KeyObject,
  expectations: TenantRuntimeBootstrapExpectations
): TenantRuntimeBootstrapPayload {
  const signed = parseDocument(raw);
  if (signed.key_id !== expectations.expectedKeyId) {
    fail('binding_mismatch', 'Bootstrap signing key is not the configured key');
  }
  const publicKey = resolvePublicKey(publicKeyInput);
  const signature = Buffer.from(signed.signature, 'base64url');
  if (signature.length !== 64) {
    fail('signature_invalid', 'Bootstrap signature has an invalid length');
  }
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(canonicalizeSignedTenantRuntimeBootstrap(signed.key_id, signed.payload), 'utf8'),
      publicKey,
      signature
    );
  } catch (error) {
    fail('signature_invalid', 'Bootstrap signature could not be verified', error);
  }
  if (!valid) fail('signature_invalid', 'Bootstrap signature is invalid');
  assertBinding(signed.payload, expectations);
  return signed.payload;
}

export interface RequireTenantRuntimeBootstrapOptions {
  readonly deploymentId: string;
  /** v1 is only a single-team/static-runtime attestation. */
  readonly tenantScope?: 'static' | 'auth_resolved';
  /** Static-runtime config identity; binds the document to the tenant it will serve. */
  readonly expectedTeamId?: string;
  readonly environment?: TenantRuntimeBootstrapEnvironment;
  readonly readFileUtf8?: (path: string) => Promise<string>;
}

/**
 * Enforce the opt-in managed-runtime startup barrier.
 *
 * No managed bootstrap environment means the feature remains unavailable and
 * returns null. Once any dedicated managed bootstrap knob is supplied, every
 * required value is mandatory and startup fails closed; there is no generated
 * identity, connected-database lookup, or HOSTNAME fallback. This function
 * cannot prove that the connected DATABASE_URL belongs to the signed database
 * incarnation; that requires a later privileged database/current-authority
 * adapter before a managed tenant may serve.
 */
export async function requireTenantRuntimeBootstrap(
  options: RequireTenantRuntimeBootstrapOptions
): Promise<TenantRuntimeBootstrapPayload | null> {
  const environment = options.environment ?? process.env;
  const managedEnvironmentKeys = [
    'AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED',
    'AGOR_TENANT_RUNTIME_BOOTSTRAP_PATH',
    'AGOR_TENANT_RUNTIME_BOOTSTRAP_PUBLIC_KEY',
    'AGOR_TENANT_RUNTIME_BOOTSTRAP_PUBLIC_KEY_PATH',
    'AGOR_TENANT_RUNTIME_BOOTSTRAP_KEY_ID',
    'AGOR_TENANT_RUNTIME_EXPECTED_DEPLOYMENT_ID',
    'AGOR_TENANT_RUNTIME_DATABASE_INCARNATION_ID',
    'AGOR_TENANT_RUNTIME_REPLICA_INCARNATION_ID',
    'AGOR_TENANT_RUNTIME_EXPECTED_TEAM_ID',
    'AGOR_TENANT_RUNTIME_EXPECTED_PLACEMENT_ID',
    'AGOR_TENANT_RUNTIME_EXPECTED_PLACEMENT_REVISION',
  ] as const;
  const required = parseRequiredBoolean(environment.AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED);
  const bootstrapPath = normalizedEnvironmentValue(environment.AGOR_TENANT_RUNTIME_BOOTSTRAP_PATH);
  const publicKey = normalizedEnvironmentValue(
    environment.AGOR_TENANT_RUNTIME_BOOTSTRAP_PUBLIC_KEY
  );
  const publicKeyPath = normalizedEnvironmentValue(
    environment.AGOR_TENANT_RUNTIME_BOOTSTRAP_PUBLIC_KEY_PATH
  );
  const managedConfigured = managedEnvironmentKeys.some((key) => Object.hasOwn(environment, key));
  if (!managedConfigured) return null;
  if (options.tenantScope === 'auth_resolved') {
    fail(
      'invalid_configuration',
      'The v1 tenant runtime bootstrap document is single-team scoped and cannot authorize an auth-resolved shared runtime'
    );
  }
  if (required === false) {
    fail(
      'invalid_configuration',
      'Managed tenant runtime bootstrap cannot be configured with REQUIRED=false'
    );
  }
  if (!bootstrapPath || !isAbsolute(bootstrapPath)) {
    fail('invalid_configuration', 'AGOR_TENANT_RUNTIME_BOOTSTRAP_PATH must be an absolute path');
  }
  if (publicKey && publicKeyPath) {
    fail(
      'invalid_configuration',
      'Configure exactly one of AGOR_TENANT_RUNTIME_BOOTSTRAP_PUBLIC_KEY or _PUBLIC_KEY_PATH'
    );
  }
  const read = options.readFileUtf8 ?? ((path: string) => readFile(path, 'utf8'));
  let rawDocument: string;
  try {
    rawDocument = await read(bootstrapPath);
  } catch (error) {
    fail(
      'invalid_configuration',
      'Cannot read the required tenant runtime bootstrap document',
      error
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(rawDocument);
  } catch (error) {
    fail('invalid_document', 'Tenant runtime bootstrap document is not valid JSON', error);
  }
  let resolvedPublicKey = publicKey;
  if (publicKeyPath) {
    if (!isAbsolute(publicKeyPath)) {
      fail(
        'invalid_configuration',
        'AGOR_TENANT_RUNTIME_BOOTSTRAP_PUBLIC_KEY_PATH must be an absolute path'
      );
    }
    try {
      resolvedPublicKey = await read(publicKeyPath);
    } catch (error) {
      fail('invalid_configuration', 'Cannot read the required tenant runtime bootstrap key', error);
    }
  }
  if (!resolvedPublicKey) {
    fail(
      'invalid_configuration',
      'A tenant runtime bootstrap public key is required when managed bootstrap is configured'
    );
  }
  const expectedKeyId = normalizedEnvironmentValue(
    environment.AGOR_TENANT_RUNTIME_BOOTSTRAP_KEY_ID
  );
  const expectedDeploymentId = normalizedEnvironmentValue(
    environment.AGOR_TENANT_RUNTIME_EXPECTED_DEPLOYMENT_ID
  );
  const databaseIncarnationId = normalizedEnvironmentValue(
    environment.AGOR_TENANT_RUNTIME_DATABASE_INCARNATION_ID
  );
  const replicaId = normalizedEnvironmentValue(environment.AGOR_DAEMON_INSTANCE_ID);
  const replicaIncarnationId = normalizedEnvironmentValue(
    environment.AGOR_TENANT_RUNTIME_REPLICA_INCARNATION_ID
  );
  if (
    !expectedKeyId ||
    !expectedDeploymentId ||
    !databaseIncarnationId ||
    !replicaId ||
    !replicaIncarnationId
  ) {
    fail(
      'invalid_configuration',
      'Managed tenant runtime bootstrap requires key ID, expected deployment ID, database incarnation ID, explicit replica ID, and replica incarnation ID'
    );
  }
  const expectedTeamId = normalizedEnvironmentValue(
    environment.AGOR_TENANT_RUNTIME_EXPECTED_TEAM_ID
  );
  if (options.expectedTeamId !== undefined) {
    assertExpectedIdentifier(options.expectedTeamId, 'expectedTeamId');
    if (expectedTeamId !== undefined && expectedTeamId !== options.expectedTeamId) {
      fail(
        'binding_mismatch',
        'Configured static tenant identity does not match the independently supplied expected team'
      );
    }
  }
  const boundTeamId = options.expectedTeamId ?? expectedTeamId;
  const expectedPlacementId = normalizedEnvironmentValue(
    environment.AGOR_TENANT_RUNTIME_EXPECTED_PLACEMENT_ID
  );
  const rawRevision = normalizedEnvironmentValue(
    environment.AGOR_TENANT_RUNTIME_EXPECTED_PLACEMENT_REVISION
  );
  let expectedPlacementRevision: number | undefined;
  if (rawRevision !== undefined) {
    if (!/^\d+$/.test(rawRevision)) {
      fail(
        'invalid_configuration',
        'AGOR_TENANT_RUNTIME_EXPECTED_PLACEMENT_REVISION must be a non-negative integer'
      );
    }
    expectedPlacementRevision = Number(rawRevision);
    if (!Number.isSafeInteger(expectedPlacementRevision)) {
      fail(
        'invalid_configuration',
        'AGOR_TENANT_RUNTIME_EXPECTED_PLACEMENT_REVISION must be a safe integer'
      );
    }
  }
  return verifyTenantRuntimeBootstrap(document, resolvedPublicKey, {
    deploymentId: options.deploymentId,
    expectedDeploymentId,
    databaseIncarnationId,
    currentReplica: { replicaId, incarnationId: replicaIncarnationId },
    expectedKeyId,
    ...(boundTeamId ? { expectedTeamId: boundTeamId } : {}),
    ...(expectedPlacementId ? { expectedPlacementId } : {}),
    ...(expectedPlacementRevision !== undefined ? { expectedPlacementRevision } : {}),
  });
}
