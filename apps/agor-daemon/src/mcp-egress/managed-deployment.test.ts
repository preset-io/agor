import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type AgorConfig, MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256 } from '@agor/core/config';
import { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import { mcpOAuthFreshPilotEnrollmentDigest } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  SYNTHETIC_PILOT_POD_UID,
  syntheticFreshPilotEnrollment,
} from '../services/test-support/managed-pilot-enrollment.js';
import {
  loadManagedOAuthCleanupDeployment,
  loadManagedOAuthDeployment,
} from './managed-deployment.js';
import { readManagedDeploymentFile } from './managed-deployment-files.js';

vi.mock('./managed-deployment-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./managed-deployment-files.js')>();
  return { ...actual, readManagedDeploymentFile: vi.fn() };
});
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const config: AgorConfig = {
  database: { dialect: 'postgresql' },
  managed_mcp_oauth: {
    enabled: true,
    broker_origin: 'https://fake.example',
    worker_issuer: 'https://fake.example/',
    environment: 'staging',
    region: 'us-west-2',
    cell_id: 'cell-a',
    credential_id: 'sender-a',
    sender_key_id: 'key-a',
    sender_private_key_path: '/owned/sender.pem',
    worker_public_keyring_path: '/owned/public.json',
    cell_evidence_path: '/owned/cell.json',
    clock_health_path: '/owned/clock.json',
    contract_sha256: MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256,
  },
};
const options: Parameters<typeof loadManagedOAuthDeployment>[1] = {
  enforcedGateway: true,
  releaseSha: 'a'.repeat(40),
  schemaDigest: 'b'.repeat(64),
  replicaId: 'replica-a',
  externalLaunchProvider: {
    enabled: true,
    providerId: 'cloud',
    issuer: 'https://identity.example/',
  },
};
const utc = 1_700_000_000_000;
let health: Record<string, unknown>;
let evidence: Record<string, unknown>;
let keyring: Record<string, unknown>;
let baseMono: number;
const nowMono = () => Number(process.hrtime.bigint()) / 1_000_000;

function freshPilotFixture() {
  const enrollment = syntheticFreshPilotEnrollment(config);
  const podUid = SYNTHETIC_PILOT_POD_UID;
  evidence = {
    ...evidence,
    pre_gateway_executors_terminated: false,
    fresh_pilot: enrollment,
    replicas: [
      {
        replica_id: podUid,
        release_sha: options.releaseSha,
        protocol_version: 1,
        binding_version: 1,
        enforcement_version: 1,
        schema_digest: options.schemaDigest,
        gateway_mode: 'enforced',
      },
    ],
  };
  health.worker_uncertainty_ms = enrollment.issuer_uncertainty_ms;
  return {
    enrollment,
    config: {
      ...config,
      managed_mcp_oauth: {
        ...config.managed_mcp_oauth,
        fresh_pilot_enrollment_sha256: mcpOAuthFreshPilotEnrollmentDigest(enrollment),
      },
    },
    options: {
      ...options,
      replicaId: podUid,
      podUid,
      podNamespace: enrollment.namespace,
      runtimeConfigDigest: enrollment.runtime_config_digest,
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  baseMono = nowMono();
  health = {
    version: 1,
    boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    synchronized: true,
    local_uncertainty_ms: 100,
    worker_uncertainty_ms: 100,
  };
  evidence = {
    cell_id: 'cell-a',
    cell_authority_epoch: '1',
    recovery_incarnation: 'R'.repeat(43),
    release_sha: options.releaseSha,
    protocol_version: 1,
    binding_version: 1,
    enforcement_version: 1,
    schema_digest: options.schemaDigest,
    replicas: [
      {
        replica_id: 'replica-a',
        release_sha: options.releaseSha,
        protocol_version: 1,
        binding_version: 1,
        enforcement_version: 1,
        schema_digest: options.schemaDigest,
        gateway_mode: 'enforced',
      },
    ],
    expected_replica_count: 1,
    pre_gateway_executors_terminated: true,
    attestation_digest: 'c'.repeat(64),
    approval_reference: 'test-only-approval',
    observed_at: utc - 1000,
    valid_until: utc + 60_000,
  };
  keyring = {
    issuer: 'https://fake.example/',
    keys: [{ kid: 'worker-a', public_key_pem: publicPem }],
  };
  vi.mocked(readManagedDeploymentFile).mockImplementation((path) => {
    if (path === '/owned/sender.pem') return Buffer.from(privatePem);
    if (path === '/owned/public.json') return Buffer.from(JSON.stringify(keyring));
    if (path === '/owned/cell.json') return Buffer.from(JSON.stringify(evidence));
    // Synthetic TEST monitor only; production never derives UTC from process time.
    if (path === '/owned/clock.json')
      return Buffer.from(
        JSON.stringify({ utc_ms: utc + nowMono() - baseMono, monotonic_ms: nowMono(), ...health })
      );
    throw new Error('No fixture');
  });
});
describe('managed production deployment loader', () => {
  it('admits only the pinned fresh lineage and actual protected Pod identity without claiming legacy termination', async () => {
    const pilot = freshPilotFixture();
    const loaded = (await loadManagedOAuthDeployment(pilot.config, pilot.options))!;
    expect(loaded.getEvidence().pre_gateway_executors_terminated).toBe(false);
    expect(loaded.getEvidence().fresh_pilot).toEqual(pilot.enrollment);
    expect(Object.isFrozen(loaded.getEvidence().fresh_pilot)).toBe(true);
    expect(loaded.clock.latestUtcMs()).toBeGreaterThanOrEqual(utc + 2600);
    evidence = { ...evidence, valid_until: utc + 90_000 };
    expect(loaded.getEvidence().valid_until).toBe(utc + 90_000);
  });

  it.each([
    { podUid: undefined },
    { podUid: 'reusable-hostname' },
    { podNamespace: undefined },
    { podNamespace: 'foreign-namespace' },
    { replicaId: 'other-diagnostic-label' },
    { runtimeConfigDigest: undefined },
    { runtimeConfigDigest: '9'.repeat(64) },
  ])('rejects pilot identity substitution or diagnostic fallback: %j', async (change) => {
    const pilot = freshPilotFixture();
    await expect(
      loadManagedOAuthDeployment(pilot.config, { ...pilot.options, ...change })
    ).rejects.toThrow('unavailable or unsafe');
  });

  it('rejects caller-style freshness, missing deployment pin, and legacy fallback on a pinned pilot', async () => {
    const legacy = structuredClone(evidence);
    const pilot = freshPilotFixture();
    await expect(loadManagedOAuthDeployment(config, pilot.options)).rejects.toThrow();
    evidence = { ...legacy, fresh: true };
    await expect(loadManagedOAuthDeployment(pilot.config, pilot.options)).rejects.toThrow();
    evidence = legacy;
    await expect(loadManagedOAuthDeployment(pilot.config, options)).rejects.toThrow();
  });

  it.each([
    ['enrollment_id', '77777777-7777-4777-8777-777777777777'],
    ['cell_birth_id', '77777777-7777-4777-8777-777777777777'],
    ['database_birth_id', '77777777-7777-4777-8777-777777777777'],
    ['namespace_uid', '77777777-7777-4777-8777-777777777777'],
    ['admission_policy_uid', '77777777-7777-4777-8777-777777777777'],
    ['admission_policy_digest', '9'.repeat(64)],
    ['runtime_image', `registry.example/old@sha256:${'9'.repeat(64)}`],
    ['worker_image', `registry.example/old@sha256:${'9'.repeat(64)}`],
    ['executor_image', `registry.example/old@sha256:${'9'.repeat(64)}`],
    ['runtime_config_digest', '9'.repeat(64)],
    ['worker_config_digest', '9'.repeat(64)],
    ['database_binding_digest', '9'.repeat(64)],
    ['source_policy_digest', '9'.repeat(64)],
  ])(
    'latches closed when admitted pilot %s changes, even if restored later',
    async (field, value) => {
      const pilot = freshPilotFixture();
      const loaded = (await loadManagedOAuthDeployment(pilot.config, pilot.options))!;
      evidence = { ...evidence, fresh_pilot: { ...pilot.enrollment, [field]: value } };
      expect(() => loaded.getEvidence()).toThrow();
      evidence = { ...evidence, fresh_pilot: pilot.enrollment };
      expect(() => loaded.getEvidence()).toThrow();
    }
  );

  it('does not downgrade an admitted pilot to legacy termination evidence', async () => {
    const pilot = freshPilotFixture();
    const loaded = (await loadManagedOAuthDeployment(pilot.config, pilot.options))!;
    evidence = { ...evidence, fresh_pilot: undefined, pre_gateway_executors_terminated: true };
    expect(() => loaded.getEvidence()).toThrow();
    evidence = {
      ...evidence,
      fresh_pilot: pilot.enrollment,
      pre_gateway_executors_terminated: false,
    };
    expect(() => loaded.getEvidence()).toThrow();
  });

  it.each([0, 1, 2499, 2501])(
    'refuses a pilot monitor substituting the admitted issuer cap with %i',
    async (cap) => {
      const pilot = freshPilotFixture();
      health.worker_uncertainty_ms = cap;
      await expect(loadManagedOAuthDeployment(pilot.config, pilot.options)).rejects.toThrow();
      expect(readManagedDeploymentFile).not.toHaveBeenCalledWith(
        '/owned/sender.pem',
        expect.anything(),
        expect.anything()
      );
    }
  );

  it('is off before any key/clock/evidence access', async () => {
    expect(await loadManagedOAuthDeployment({}, options)).toBeNull();
    expect(
      await loadManagedOAuthDeployment({ managed_mcp_oauth: { enabled: false } }, options)
    ).toBeNull();
    expect(readManagedDeploymentFile).not.toHaveBeenCalled();
  });
  it('loads pinned public keys, a bounded clock and actual fresh same-cohort evidence', async () => {
    const loaded = (await loadManagedOAuthDeployment(config, options))!;
    expect(loaded.issuer).toBe('https://fake.example/');
    expect(loaded.identity).toEqual({ provider: 'cloud', issuer: 'https://identity.example/' });
    expect(loaded.keys.size).toBe(1);
    expect('set' in loaded.keys).toBe(false);
    expect(loaded.keys.get('worker-a')?.type).toBe('public');
    expect(loaded.clock.latestUtcMs()).toBeGreaterThanOrEqual(utc + 200);
    expect(loaded.getEvidence().cell_id).toBe('cell-a');
    evidence = { ...evidence, valid_until: utc + 90_000 };
    expect(loaded.getEvidence().valid_until).toBe(utc + 90_000);
    expect(Object.isFrozen(loaded.getEvidence().replicas)).toBe(true);
    keyring.keys = [];
    expect(loaded.keys.size).toBe(1); // startup keyring is immutable, not an online discovery feed
  });
  it.each([
    { database: { dialect: 'sqlite' } },
    { managed_mcp_oauth: { ...config.managed_mcp_oauth, contract_sha256: '0'.repeat(64) } },
    { managed_mcp_oauth: { ...config.managed_mcp_oauth, region: 'eu-west-1' } },
  ])('refuses unsafe deployment configuration before key reads', async (changes) => {
    await expect(
      loadManagedOAuthDeployment({ ...config, ...changes } as AgorConfig, options)
    ).rejects.toThrow('unavailable or unsafe');
    expect(readManagedDeploymentFile).not.toHaveBeenCalled();
  });
  it.each([
    { enforcedGateway: false },
    { releaseSha: 'dev' },
    { schemaDigest: 'short' },
    { externalLaunchProvider: { enabled: false } },
  ])('refuses untrusted deployment authority %j', async (change) => {
    await expect(loadManagedOAuthDeployment(config, { ...options, ...change })).rejects.toThrow();
    expect(readManagedDeploymentFile).not.toHaveBeenCalled();
  });
  it.each([
    { synchronized: false },
    { boot_id: '00000000-0000-4000-8000-000000000000' },
    { monotonic_ms: 0 },
    { local_uncertainty_ms: 4901 },
    { worker_uncertainty_ms: 5001 },
  ])('refuses unsafe monitor evidence %j', async (change) => {
    health = { ...health, ...change };
    await expect(loadManagedOAuthDeployment(config, options)).rejects.toThrow();
    expect(readManagedDeploymentFile).not.toHaveBeenCalledWith(
      '/owned/sender.pem',
      expect.anything(),
      expect.anything()
    );
  });
  it('latches a clock failure after startup rather than returning Date.now fallback', async () => {
    const loaded = (await loadManagedOAuthDeployment(config, options))!;
    health.synchronized = false;
    expect(() => loaded.clock.latestUtcMs()).toThrow();
    health.synchronized = true;
    expect(() => loaded.clock.latestUtcMs()).toThrow();
  });
  it.each([
    { cell_id: 'other-cell' },
    { release_sha: 'd'.repeat(40) },
    { schema_digest: 'e'.repeat(64) },
    { expected_replica_count: 2 },
    { pre_gateway_executors_terminated: false },
    { valid_until: utc - 1 },
  ])('refuses incomplete, foreign, mixed or expired cohort %j', async (change) => {
    evidence = { ...evidence, ...change };
    await expect(loadManagedOAuthDeployment(config, options)).rejects.toThrow();
  });
  it('rejects changed incarnation after startup and missing this replica', async () => {
    const loaded = (await loadManagedOAuthDeployment(config, options))!;
    evidence.recovery_incarnation = 'X'.repeat(43);
    expect(() => loaded.getEvidence()).toThrow();
    evidence.recovery_incarnation = 'R'.repeat(43);
    expect(() => loaded.getEvidence()).toThrow();
    await expect(
      loadManagedOAuthDeployment(config, { ...options, replicaId: 'old-replica' })
    ).rejects.toThrow();
  });
  it.each([
    { issuer: 'https://other.example/' },
    { keys: [{ kid: 'worker-a', public_key_pem: privatePem }] },
    { keys: [{ kid: 'worker-a', public_key_pem: publicPem + privatePem }] },
    {
      keys: [
        { kid: 'worker-a', public_key_pem: publicPem },
        { kid: 'worker-a', public_key_pem: publicPem },
      ],
    },
  ])('rejects issuer, private-key inventory or duplicate key IDs', async (change) => {
    keyring = { ...keyring, ...change };
    await expect(loadManagedOAuthDeployment(config, options)).rejects.toThrow();
  });
});

describe('cleanup-only deployment loader', () => {
  const cleanupConfig = () => ({
    ...config,
    managed_mcp_oauth: { ...config.managed_mcp_oauth, enabled: false, revocation: true },
  });
  it('does no IO when cleanup is off, regardless of vending flag', async () => {
    expect(await loadManagedOAuthCleanupDeployment({}, options)).toBeNull();
    expect(await loadManagedOAuthCleanupDeployment(config, options)).toBeNull();
    expect(readManagedDeploymentFile).not.toHaveBeenCalled();
  });
  it('loads shutdown cleanup without public keys or mixed/absent cohort admission', async () => {
    evidence = {};
    keyring = {};
    const loaded = await loadManagedOAuthCleanupDeployment(cleanupConfig(), options);
    expect(loaded).not.toBeNull();
    expect(loaded).not.toHaveProperty('keys');
    expect(loaded).not.toHaveProperty('getEvidence');
    expect(loaded?.sender).not.toHaveProperty('execute');
    expect(loaded?.identity).toEqual({ provider: 'cloud', issuer: 'https://identity.example/' });
    expect(
      vi
        .mocked(readManagedDeploymentFile)
        .mock.calls.every(([path]) => ['/owned/clock.json', '/owned/sender.pem'].includes(path))
    ).toBe(true);
    expect(await loadManagedOAuthDeployment(cleanupConfig(), options)).toBeNull();
  });
  it.each(['prepare', 'activate', 'exchange', 'refresh', 'authority', 'receipt'] as const)(
    'refuses %s before dispatch',
    async (operation) => {
      const loaded = await loadManagedOAuthCleanupDeployment(cleanupConfig(), options);
      const dispatch = vi
        .spyOn(ManagedMCPOAuthClient.prototype, 'request')
        .mockRejectedValue(new Error('must not dispatch'));
      try {
        await expect(
          loaded!.sender.request({
            operation,
            body: { operation_id: 'fake' },
            schema: z.unknown(),
            assertCurrent: () => {},
          })
        ).rejects.toThrow('Managed');
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        dispatch.mockRestore();
      }
    }
  );
  it.each(['cancel', 'cancel_reservation', 'close', 'cleanup', 'ack', 'capabilities'] as const)(
    'retains caller authority fence for %s',
    async (operation) => {
      const loaded = await loadManagedOAuthCleanupDeployment(cleanupConfig(), options);
      const fence = vi.fn(() => {
        throw new Error('quarantined recovery');
      });
      const request = {
        operation,
        body: { operation_id: 'fake' },
        schema: z.unknown(),
        assertCurrent: fence,
      };
      const dispatch = vi
        .spyOn(ManagedMCPOAuthClient.prototype, 'request')
        .mockImplementation(async (input) => {
          await input.assertCurrent();
          throw new Error('unreachable');
        });
      try {
        await expect(loaded!.sender.request(request)).rejects.toThrow('quarantined recovery');
        expect(dispatch).toHaveBeenCalledWith(request);
        expect(fence).toHaveBeenCalledOnce();
      } finally {
        dispatch.mockRestore();
      }
    }
  );
  it('requires complete cleanup wiring and trusted clock even with master off', async () => {
    const missing = cleanupConfig();
    missing.managed_mcp_oauth.worker_issuer = undefined;
    await expect(loadManagedOAuthCleanupDeployment(missing, options)).rejects.toThrow();
    health.synchronized = false;
    await expect(loadManagedOAuthCleanupDeployment(cleanupConfig(), options)).rejects.toThrow();
  });
  it('does not waive PostgreSQL, source pin or configured identity', async () => {
    for (const input of [
      { ...cleanupConfig(), database: { dialect: 'sqlite' } },
      {
        ...cleanupConfig(),
        managed_mcp_oauth: {
          ...cleanupConfig().managed_mcp_oauth,
          contract_sha256: 'a'.repeat(64),
        },
      },
    ])
      await expect(
        loadManagedOAuthCleanupDeployment(input as AgorConfig, options)
      ).rejects.toThrow();
    await expect(
      loadManagedOAuthCleanupDeployment(cleanupConfig(), {
        externalLaunchProvider: { enabled: false },
      })
    ).rejects.toThrow();
  });
});
