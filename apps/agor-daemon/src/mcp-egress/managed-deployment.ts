import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  type AgorConfig,
  MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256,
  type ResolvedExternalLaunchProvider,
  validateManagedMCPOAuthConfig,
} from '@agor/core/config';
import { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import {
  MCP_OAUTH_LIMITS,
  McpOAuthCellEvidenceSchema,
  McpOAuthIdSchema,
  mcpOAuthParseJson,
} from '@agor/core/types';
import { z } from 'zod';
import { ManagedAuthorityClock } from './managed-clock.js';
import { ManagedDeploymentError, readManagedDeploymentFile } from './managed-deployment-files.js';

const ClockHealthSchema = z.strictObject({
  version: z.literal(1),
  boot_id: z.uuid(),
  monotonic_ms: z.number().finite().nonnegative(),
  utc_ms: z.number().finite().positive(),
  local_uncertainty_ms: z.number().finite().nonnegative(),
  worker_uncertainty_ms: z.number().finite().nonnegative(),
  synchronized: z.literal(true),
});
const KeyringSchema = z.strictObject({
  issuer: z.string(),
  keys: z
    .array(z.strictObject({ kid: McpOAuthIdSchema, public_key_pem: z.string().min(1).max(16_384) }))
    .min(1)
    .max(8),
});
const monotonicNow = () => Number(process.hrtime.bigint()) / 1_000_000;
type CellEvidence = ReturnType<typeof McpOAuthCellEvidenceSchema.parse>;

export interface ManagedOAuthDeployment {
  readonly clock: ManagedAuthorityClock;
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly sender: ManagedMCPOAuthClient;
  readonly issuer: string;
  readonly identity: Readonly<{ provider: string; issuer: string }>;
  /** Reads fresh external cohort attestation; expired/mixed/changed authority denies. */
  getEvidence(): CellEvidence;
}

function immutableKeys(map: Map<string, KeyObject>): ReadonlyMap<string, KeyObject> {
  const view: ReadonlyMap<string, KeyObject> = Object.freeze({
    size: map.size,
    get: (key: string) => map.get(key),
    has: (key: string) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
    forEach: (
      callback: (value: KeyObject, key: string, map: ReadonlyMap<string, KeyObject>) => void,
      thisArg?: unknown
    ) =>
      map.forEach((value, key) => {
        callback.call(thisArg, value, key, view);
      }),
  });
  return view;
}

type IdentityProvider = Pick<ResolvedExternalLaunchProvider, 'enabled' | 'providerId' | 'issuer'>;

/** No cohort or worker public-key reads: these materials cannot admit a grant. */
function loadSenderMaterial(config: AgorConfig, externalLaunchProvider: IdentityProvider) {
  const settings = Object.freeze({ ...config.managed_mcp_oauth });
  validateManagedMCPOAuthConfig(settings);
  if (
    process.platform !== 'linux' ||
    config.database?.dialect !== 'postgresql' ||
    settings.region !== 'us-west-2' ||
    settings.contract_sha256 !== MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256
  )
    throw new Error();
  const provider = externalLaunchProvider;
  const providerId = provider.providerId ?? provider.issuer;
  if (
    !provider.enabled ||
    !provider.issuer ||
    !providerId ||
    provider.issuer !== provider.issuer.trim() ||
    providerId !== providerId.trim()
  )
    throw new Error();
  const identity = Object.freeze({ provider: providerId, issuer: provider.issuer });
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!z.uuid().safeParse(bootId).success) throw new Error();
  const clock = new ManagedAuthorityClock(() => {
    try {
      const sample = ClockHealthSchema.parse(
        mcpOAuthParseJson(
          readManagedDeploymentFile(settings.clock_health_path!, 4096).toString('utf8'),
          4096
        )
      );
      const combined = sample.local_uncertainty_ms + sample.worker_uncertainty_ms;
      if (sample.boot_id !== bootId || combined > MCP_OAUTH_LIMITS.use_clock_allowance_ms)
        return null;
      return {
        utcMs: sample.utc_ms,
        monotonicMs: sample.monotonic_ms,
        combinedUncertaintyMs: combined,
        safe: true,
      };
    } catch {
      return null;
    }
  }, monotonicNow);
  clock.latestUtcMs();
  const privateBytes = readManagedDeploymentFile(settings.sender_private_key_path!, 16_384, true);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateBytes);
  } finally {
    privateBytes.fill(0);
  }
  const sender = new ManagedMCPOAuthClient({
    origin: settings.broker_origin!,
    environment: settings.environment!,
    region: settings.region!,
    cellId: settings.cell_id!,
    credentialId: settings.credential_id!,
    keyId: settings.sender_key_id!,
    privateKey,
    now: () => clock.latestUtcMs(),
  });
  return { identity, clock, sender, issuer: settings.worker_issuer! };
}

export interface ManagedOAuthCleanupDeployment {
  readonly clock: ManagedAuthorityClock;
  readonly issuer: string;
  readonly identity: Readonly<{ provider: string; issuer: string }>;
  /** Runtime-restricted nonvending operations only, never a full broker client. */
  readonly sender: Pick<ManagedMCPOAuthClient, 'request'>;
}

/**
 * Shutdown cleanup is independent of vending admission. The coordinator MUST
 * bind each historical owner to fresh authenticated capabilities/recovery
 * incarnation before dispatch; this adapter does not waive recovery quarantine.
 */
export async function loadManagedOAuthCleanupDeployment(
  config: AgorConfig,
  options: { externalLaunchProvider: IdentityProvider }
): Promise<ManagedOAuthCleanupDeployment | null> {
  if (config.managed_mcp_oauth?.revocation !== true) return null;
  try {
    const { clock, issuer, identity, sender } = loadSenderMaterial(
      config,
      options.externalLaunchProvider
    );
    const restricted: Pick<ManagedMCPOAuthClient, 'request'> = Object.freeze({
      request: ((request) => {
        if (!['cancel', 'close', 'cleanup', 'ack', 'capabilities'].includes(request.operation)) {
          return Promise.reject(new ManagedDeploymentError());
        }
        return sender.request(request);
      }) as ManagedMCPOAuthClient['request'],
    });
    return Object.freeze({ clock, issuer, identity, sender: restricted });
  } catch {
    throw new ManagedDeploymentError();
  }
}

/** System-global deployment inputs only. Never pass request/session/body-selected options. */
export async function loadManagedOAuthDeployment(
  config: AgorConfig,
  options: {
    enforcedGateway: boolean;
    releaseSha: string;
    schemaDigest: string;
    replicaId: string;
    /** The daemon's already resolved, retained external-launch provider. */
    externalLaunchProvider: Pick<
      ResolvedExternalLaunchProvider,
      'enabled' | 'providerId' | 'issuer'
    >;
  }
): Promise<ManagedOAuthDeployment | null> {
  // Disabled deployments do not read any key, clock, provider or cohort files.
  if (config.managed_mcp_oauth?.enabled !== true) return null;
  try {
    const settings = Object.freeze({ ...config.managed_mcp_oauth });
    validateManagedMCPOAuthConfig(settings);
    if (
      process.platform !== 'linux' ||
      config.database?.dialect !== 'postgresql' ||
      !options.enforcedGateway ||
      settings.region !== 'us-west-2' ||
      settings.contract_sha256 !== MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256 ||
      !/^[a-f0-9]{40}$/.test(options.releaseSha) ||
      !/^[a-f0-9]{64}$/.test(options.schemaDigest)
    )
      throw new Error();
    McpOAuthIdSchema.parse(options.replicaId);
    const { identity, clock, sender } = loadSenderMaterial(config, options.externalLaunchProvider);
    const rawKeys = KeyringSchema.parse(
      mcpOAuthParseJson(
        readManagedDeploymentFile(settings.worker_public_keyring_path!, 131_072).toString('utf8'),
        131_072
      )
    );
    if (rawKeys.issuer !== settings.worker_issuer) throw new Error();
    const parsedKeys = new Map<string, KeyObject>();
    for (const item of rawKeys.keys) {
      // createPublicKey also accepts a PRIVATE KEY and extracts its public half;
      // refuse that accidental credential-bearing inventory explicitly.
      if (
        !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(
          item.public_key_pem
        )
      )
        throw new Error();
      const key = createPublicKey(item.public_key_pem);
      if (
        key.type !== 'public' ||
        key.asymmetricKeyType !== 'rsa' ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        parsedKeys.has(item.kid)
      )
        throw new Error();
      parsedKeys.set(item.kid, key);
    }
    const expected = Object.freeze({
      cellId: settings.cell_id,
      releaseSha: options.releaseSha,
      schemaDigest: options.schemaDigest,
      replicaId: options.replicaId,
    });
    let cohortIdentity: string | undefined;
    let cohortChanged = false;
    const getEvidence = (): CellEvidence => {
      try {
        if (cohortChanged) throw new Error();
        const evidence = McpOAuthCellEvidenceSchema.parse(
          mcpOAuthParseJson(
            readManagedDeploymentFile(settings.cell_evidence_path!, 65_536).toString('utf8'),
            65_536
          )
        );
        const now = clock.latestUtcMs();
        if (
          evidence.cell_id !== expected.cellId ||
          evidence.release_sha !== expected.releaseSha ||
          evidence.schema_digest !== expected.schemaDigest ||
          !evidence.replicas.some((replica) => replica.replica_id === expected.replicaId)
        ) {
          cohortChanged = true;
          throw new Error();
        }
        if (evidence.observed_at > now || evidence.valid_until <= now) throw new Error();
        const identity = JSON.stringify([
          evidence.cell_id,
          evidence.cell_authority_epoch,
          evidence.recovery_incarnation,
          evidence.release_sha,
          evidence.schema_digest,
          evidence.replicas.map((replica) => replica.replica_id).sort(),
        ]);
        if (cohortIdentity !== undefined && cohortIdentity !== identity) {
          cohortChanged = true;
          throw new Error();
        }
        cohortIdentity ??= identity;
        for (const replica of evidence.replicas) Object.freeze(replica);
        Object.freeze(evidence.replicas);
        return Object.freeze(evidence);
      } catch {
        throw new ManagedDeploymentError();
      }
    };
    getEvidence();
    return Object.freeze({
      clock,
      keys: immutableKeys(parsedKeys),
      sender,
      issuer: settings.worker_issuer!,
      identity,
      getEvidence,
    });
  } catch {
    throw new ManagedDeploymentError();
  }
}
