import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeSignedTenantRuntimeBootstrap,
  canonicalizeTenantRuntimeBootstrapPayload,
  requireTenantRuntimeBootstrap,
  type SignedTenantRuntimeBootstrap,
  type TenantRuntimeBootstrapError,
  type TenantRuntimeBootstrapPayload,
  verifyTenantRuntimeBootstrap,
} from './tenant-runtime-bootstrap.js';

const DEPLOYMENT_ID = '019c1234-5678-7123-8123-123456789abc';
const OTHER_DEPLOYMENT_ID = '019c1234-5678-7123-8123-123456789abd';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

function payload(
  overrides: Partial<TenantRuntimeBootstrapPayload> = {}
): TenantRuntimeBootstrapPayload {
  return {
    kind: 'agor.tenant-runtime-bootstrap',
    version: 1,
    deployment_id: DEPLOYMENT_ID,
    database_incarnation_id: 'db-incarnation-a',
    database_name: 'agor-runtime',
    logical_database_id: 'pg-oid-123',
    team_id: 'team-a',
    placement_id: 'placement-a',
    placement_revision: 7,
    placement_origin: 'https://runtime.example.test/cell-a',
    replica_inventory: [
      { replica_id: 'replica-a', incarnation_id: 'replica-incarnation-a' },
      { replica_id: 'replica-b', incarnation_id: 'replica-incarnation-b' },
    ],
    restore_policy: 'closed',
    issued_at: '2026-09-16T12:00:00.000Z',
    ...overrides,
  };
}

function signedBootstrap(
  input: TenantRuntimeBootstrapPayload = payload()
): SignedTenantRuntimeBootstrap {
  const signature = sign(
    null,
    Buffer.from(canonicalizeSignedTenantRuntimeBootstrap('cloud-key-a', input), 'utf8'),
    privateKey
  ).toString('base64url');
  return { key_id: 'cloud-key-a', payload: input, signature };
}

function expectations(overrides: Record<string, unknown> = {}) {
  return {
    deploymentId: DEPLOYMENT_ID,
    expectedDeploymentId: DEPLOYMENT_ID,
    databaseIncarnationId: 'db-incarnation-a',
    currentReplica: { replicaId: 'replica-a', incarnationId: 'replica-incarnation-a' },
    expectedKeyId: 'cloud-key-a',
    ...overrides,
  } as Parameters<typeof verifyTenantRuntimeBootstrap>[2];
}

describe('tenant runtime bootstrap contract', () => {
  it('verifies a signed placement, database, and replica inventory binding', () => {
    expect(verifyTenantRuntimeBootstrap(signedBootstrap(), publicKeyPem, expectations())).toEqual(
      payload()
    );
  });

  it('rejects tampered payloads and signatures before checking bindings', async () => {
    const signed = signedBootstrap();
    await expectReject(
      () =>
        verifyTenantRuntimeBootstrap(
          { ...signed, payload: { ...signed.payload, team_id: 'team-b' } },
          publicKeyPem,
          expectations()
        ),
      'signature_invalid'
    );
    await expectReject(
      () =>
        verifyTenantRuntimeBootstrap(
          { ...signed, key_id: 'cloud-key-b' },
          publicKeyPem,
          expectations({ expectedKeyId: 'cloud-key-b' })
        ),
      'signature_invalid'
    );
    await expectReject(
      () =>
        verifyTenantRuntimeBootstrap(
          { ...signed, signature: signed.signature.slice(0, -1) },
          publicKeyPem,
          expectations()
        ),
      'signature_invalid'
    );
  });

  it.each([
    ['copied deployment config', { expectedDeploymentId: OTHER_DEPLOYMENT_ID }, 'binding_mismatch'],
    ['copied database', { databaseIncarnationId: 'db-incarnation-clone' }, 'binding_mismatch'],
    [
      'wrong replica incarnation',
      { currentReplica: { replicaId: 'replica-a', incarnationId: 'replacement' } },
      'binding_mismatch',
    ],
    ['wrong placement revision', { expectedPlacementRevision: 8 }, 'binding_mismatch'],
  ] as const)('%s fails closed', async (_label, override, code) => {
    await expectReject(
      () => verifyTenantRuntimeBootstrap(signedBootstrap(), publicKeyPem, expectations(override)),
      code
    );
  });

  it('rejects duplicate or unsorted replica inventory and non-closed restores', async () => {
    const duplicate = payload({
      replica_inventory: [
        { replica_id: 'replica-a', incarnation_id: 'one' },
        { replica_id: 'replica-a', incarnation_id: 'two' },
      ],
    });
    await expectReject(
      () => verifyTenantRuntimeBootstrap(signedBootstrap(duplicate), publicKeyPem, expectations()),
      'invalid_document'
    );

    const unsorted = payload({
      replica_inventory: [
        { replica_id: 'replica-b', incarnation_id: 'two' },
        { replica_id: 'replica-a', incarnation_id: 'one' },
      ],
    });
    await expectReject(
      () => verifyTenantRuntimeBootstrap(signedBootstrap(unsorted), publicKeyPem, expectations()),
      'invalid_document'
    );

    const deterministicMixedCase = payload({
      replica_inventory: [
        { replica_id: 'Replica-a', incarnation_id: 'one' },
        { replica_id: 'replica-a', incarnation_id: 'two' },
      ],
    });
    expect(
      verifyTenantRuntimeBootstrap(
        signedBootstrap(deterministicMixedCase),
        publicKeyPem,
        expectations({ currentReplica: { replicaId: 'Replica-a', incarnationId: 'one' } })
      )
    ).toEqual(deterministicMixedCase);

    const restore = signedBootstrap({ ...payload(), restore_policy: 'same_database' as never });
    await expectReject(
      () => verifyTenantRuntimeBootstrap(restore, publicKeyPem, expectations()),
      'invalid_document'
    );
  });

  it('requires an Ed25519 key and a matching key id', async () => {
    await expectReject(
      () =>
        verifyTenantRuntimeBootstrap(
          signedBootstrap(),
          publicKeyPem,
          expectations({ expectedKeyId: 'other-key' })
        ),
      'binding_mismatch'
    );
    const { privateKey: rsaPrivateKey, publicKey: rsaPublicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const rsaSignature = sign(
      'sha256',
      Buffer.from(canonicalizeTenantRuntimeBootstrapPayload(payload())),
      rsaPrivateKey
    ).toString('base64url');
    await expectReject(
      () =>
        verifyTenantRuntimeBootstrap(
          { key_id: 'cloud-key-a', payload: payload(), signature: rsaSignature },
          rsaPublicKey,
          expectations()
        ),
      'invalid_configuration'
    );
  });

  it('does nothing for an unconfigured standalone process', async () => {
    await expect(
      requireTenantRuntimeBootstrap({ deploymentId: DEPLOYMENT_ID, environment: {} })
    ).resolves.toBeNull();
  });

  it('requires every independently supplied value once managed bootstrap is configured', async () => {
    await expectReject(
      () =>
        requireTenantRuntimeBootstrap({
          deploymentId: DEPLOYMENT_ID,
          environment: { AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED: 'true' },
        }),
      'invalid_configuration'
    );
    await expectReject(
      () =>
        requireTenantRuntimeBootstrap({
          deploymentId: DEPLOYMENT_ID,
          environment: {
            AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED: 'false',
            AGOR_TENANT_RUNTIME_BOOTSTRAP_PATH: '/run/agor/bootstrap.json',
          },
        }),
      'invalid_configuration'
    );
    await expectReject(
      () =>
        requireTenantRuntimeBootstrap({
          deploymentId: DEPLOYMENT_ID,
          environment: { AGOR_TENANT_RUNTIME_EXPECTED_DEPLOYMENT_ID: DEPLOYMENT_ID },
        }),
      'invalid_configuration'
    );
    await expectReject(
      () =>
        requireTenantRuntimeBootstrap({
          deploymentId: DEPLOYMENT_ID,
          environment: { AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED: 'false' },
        }),
      'invalid_configuration'
    );
  });

  it('does not treat a single-team document as shared auth-resolved authority', async () => {
    await expectReject(
      () =>
        requireTenantRuntimeBootstrap({
          deploymentId: DEPLOYMENT_ID,
          tenantScope: 'auth_resolved',
          environment: { AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED: 'true' },
        }),
      'invalid_configuration'
    );
  });

  it('loads and verifies a managed bootstrap without HOSTNAME or database fallback', async () => {
    const document = signedBootstrap();
    const readFileUtf8 = vi.fn(async (path: string) => {
      if (path === '/run/agor/bootstrap.json') return JSON.stringify(document);
      if (path === '/run/agor/bootstrap.pub') return publicKeyPem;
      throw new Error(`unexpected path ${path}`);
    });
    const environment = {
      AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED: 'true',
      AGOR_TENANT_RUNTIME_BOOTSTRAP_PATH: '/run/agor/bootstrap.json',
      AGOR_TENANT_RUNTIME_BOOTSTRAP_PUBLIC_KEY_PATH: '/run/agor/bootstrap.pub',
      AGOR_TENANT_RUNTIME_BOOTSTRAP_KEY_ID: 'cloud-key-a',
      AGOR_TENANT_RUNTIME_EXPECTED_DEPLOYMENT_ID: DEPLOYMENT_ID,
      AGOR_TENANT_RUNTIME_DATABASE_INCARNATION_ID: 'db-incarnation-a',
      AGOR_DAEMON_INSTANCE_ID: 'replica-a',
      AGOR_TENANT_RUNTIME_REPLICA_INCARNATION_ID: 'replica-incarnation-a',
      AGOR_TENANT_RUNTIME_EXPECTED_TEAM_ID: 'team-a',
      AGOR_TENANT_RUNTIME_EXPECTED_PLACEMENT_ID: 'placement-a',
      AGOR_TENANT_RUNTIME_EXPECTED_PLACEMENT_REVISION: '7',
    };
    await expect(
      requireTenantRuntimeBootstrap({
        deploymentId: DEPLOYMENT_ID,
        readFileUtf8,
        expectedTeamId: 'team-a',
        environment,
      })
    ).resolves.toEqual(payload());
    expect(readFileUtf8).toHaveBeenCalledWith('/run/agor/bootstrap.json');
    expect(readFileUtf8).toHaveBeenCalledWith('/run/agor/bootstrap.pub');
    await expectReject(
      () =>
        requireTenantRuntimeBootstrap({
          deploymentId: DEPLOYMENT_ID,
          readFileUtf8,
          expectedTeamId: 'team-b',
          environment,
        }),
      'binding_mismatch'
    );
  });

  it('does not substitute HOSTNAME when the explicit replica identity is missing', async () => {
    const document = signedBootstrap();
    await expectReject(
      () =>
        requireTenantRuntimeBootstrap({
          deploymentId: DEPLOYMENT_ID,
          readFileUtf8: async () => JSON.stringify(document),
          environment: {
            AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED: 'true',
            AGOR_TENANT_RUNTIME_BOOTSTRAP_PATH: '/run/agor/bootstrap.json',
            AGOR_TENANT_RUNTIME_BOOTSTRAP_PUBLIC_KEY: publicKeyPem,
            AGOR_TENANT_RUNTIME_BOOTSTRAP_KEY_ID: 'cloud-key-a',
            AGOR_TENANT_RUNTIME_EXPECTED_DEPLOYMENT_ID: DEPLOYMENT_ID,
            AGOR_TENANT_RUNTIME_DATABASE_INCARNATION_ID: 'db-incarnation-a',
            AGOR_TENANT_RUNTIME_REPLICA_INCARNATION_ID: 'replica-incarnation-a',
          },
        }),
      'invalid_configuration'
    );
  });
});

async function expectReject<T>(promise: () => T | Promise<T>, code: string): Promise<void> {
  await expect(Promise.resolve().then(promise)).rejects.toMatchObject({
    code,
    name: 'TenantRuntimeBootstrapError',
  } satisfies Partial<TenantRuntimeBootstrapError>);
}
