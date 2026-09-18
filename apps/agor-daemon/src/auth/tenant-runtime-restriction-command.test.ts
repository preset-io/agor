import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import goldenFixture from './fixtures/tenant-runtime-restriction-command.golden.json';
import type { TenantRuntimeBootstrapPayload } from './tenant-runtime-bootstrap.js';
import type { TenantRuntimeCurrentAuthority } from './tenant-runtime-current-authority.js';
import {
  canonicalizeSignedTenantRuntimeRestrictionCommand,
  type SignedTenantRuntimeRestrictionCommand,
  type TenantRuntimeRestrictionCommandError,
  type TenantRuntimeRestrictionCommandPayload,
  verifyTenantRuntimeRestrictionCommand,
} from './tenant-runtime-restriction-command.js';

const DEPLOYMENT_ID = '019c1234-5678-7123-8123-123456789abc';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

const bootstrap: TenantRuntimeBootstrapPayload = {
  kind: 'agor.tenant-runtime-bootstrap',
  version: 1,
  deployment_id: DEPLOYMENT_ID,
  database_incarnation_id: 'db-incarnation-a',
  database_name: 'agor-runtime',
  logical_database_id: 'logical-db-a',
  team_id: 'team-a',
  placement_id: 'placement-a',
  placement_revision: 7,
  placement_origin: 'https://runtime.example.test/cell-a',
  replica_inventory: [{ replica_id: 'replica-a', incarnation_id: 'replica-incarnation-a' }],
  restore_policy: 'closed',
  issued_at: '2026-09-16T12:00:00.000Z',
};

const currentAuthority: TenantRuntimeCurrentAuthority = {
  identityKey: 'primary',
  protocolVersion: 1,
  deploymentId: bootstrap.deployment_id,
  databaseIncarnationId: bootstrap.database_incarnation_id,
  databaseName: bootstrap.database_name,
  logicalDatabaseId: bootstrap.logical_database_id,
  teamId: bootstrap.team_id,
  placementId: bootstrap.placement_id,
  placementRevision: bootstrap.placement_revision,
  placementOrigin: bootstrap.placement_origin,
};

function payload(
  overrides: Partial<TenantRuntimeRestrictionCommandPayload> = {}
): TenantRuntimeRestrictionCommandPayload {
  return {
    kind: 'agor.tenant-runtime-restriction-command',
    version: 1,
    tenant_id: 'workspace-a',
    deployment_id: bootstrap.deployment_id,
    database_incarnation_id: bootstrap.database_incarnation_id,
    database_name: bootstrap.database_name,
    logical_database_id: bootstrap.logical_database_id,
    team_id: bootstrap.team_id,
    placement_id: bootstrap.placement_id,
    placement_origin: bootstrap.placement_origin,
    placement_revision: bootstrap.placement_revision,
    controller_id: 'agor-cloud-team-suspension-v1',
    operation_id: 'team_suspension_operation_a',
    revision: 4,
    action: 'restrict',
    issued_at: '2026-09-16T12:01:00.000Z',
    ...overrides,
  };
}

function signedCommand(
  commandPayload: TenantRuntimeRestrictionCommandPayload = payload(),
  keyId = 'cloud-key-a'
): SignedTenantRuntimeRestrictionCommand {
  const signature = sign(
    null,
    Buffer.from(canonicalizeSignedTenantRuntimeRestrictionCommand(keyId, commandPayload), 'utf8'),
    privateKey
  ).toString('base64url');
  return { key_id: keyId, payload: commandPayload, signature };
}

const expectations = {
  bootstrap,
  currentAuthority,
  expectedKeyId: 'cloud-key-a',
  expectedControllerId: 'agor-cloud-team-suspension-v1',
};

async function expectReject(
  operation: () => unknown,
  code: TenantRuntimeRestrictionCommandError['code']
): Promise<void> {
  await expect(Promise.resolve().then(operation)).rejects.toMatchObject({
    name: 'TenantRuntimeRestrictionCommandError',
    code,
  } satisfies Partial<TenantRuntimeRestrictionCommandError>);
}

describe('signed tenant runtime restriction command', () => {
  it('verifies the command and returns the runtime transition without mutating state', () => {
    expect(
      verifyTenantRuntimeRestrictionCommand(signedCommand(), publicKeyPem, expectations)
    ).toEqual(
      expect.objectContaining({
        keyId: 'cloud-key-a',
        tenantId: 'workspace-a',
        command: {
          version: 1,
          controllerId: 'agor-cloud-team-suspension-v1',
          placementId: 'placement-a',
          operationId: 'team_suspension_operation_a',
          revision: 4,
          action: 'restrict',
        },
      })
    );
  });

  it('covers the key id and payload in the signed bytes', async () => {
    const signed = signedCommand();
    await expectReject(
      () =>
        verifyTenantRuntimeRestrictionCommand(
          { ...signed, payload: { ...signed.payload, tenant_id: 'workspace-b' } },
          publicKeyPem,
          expectations
        ),
      'signature_invalid'
    );
    await expectReject(
      () =>
        verifyTenantRuntimeRestrictionCommand({ ...signed, key_id: 'cloud-key-b' }, publicKeyPem, {
          ...expectations,
          expectedKeyId: 'cloud-key-b',
        }),
      'signature_invalid'
    );
    await expectReject(
      () =>
        verifyTenantRuntimeRestrictionCommand(
          { ...signed, signature: signed.signature.slice(0, -1) },
          publicKeyPem,
          expectations
        ),
      'signature_invalid'
    );
  });

  it('rejects a malformed envelope and invalid key/configuration', async () => {
    await expectReject(
      () =>
        verifyTenantRuntimeRestrictionCommand(
          { ...signedCommand(), extra: true },
          publicKeyPem,
          expectations
        ),
      'invalid_document'
    );
    await expectReject(
      () =>
        verifyTenantRuntimeRestrictionCommand(signedCommand(), publicKeyPem, {
          ...expectations,
          expectedControllerId: '',
        }),
      'invalid_configuration'
    );
    await expectReject(
      () =>
        verifyTenantRuntimeRestrictionCommand(signedCommand(), 'not-a-public-key', expectations),
      'invalid_configuration'
    );
  });

  it.each([
    ['wrong controller', { controller_id: 'other-controller' }, 'binding_mismatch'],
    [
      'wrong deployment',
      { deployment_id: '019c1234-5678-7123-8123-123456789abd' },
      'binding_mismatch',
    ],
    ['wrong database identity', { logical_database_id: 'logical-db-clone' }, 'binding_mismatch'],
    [
      'wrong placement origin',
      { placement_origin: 'https://runtime.example.test/cell-b' },
      'binding_mismatch',
    ],
    ['wrong placement revision', { placement_revision: 8 }, 'binding_mismatch'],
  ] as const)('%s fails closed', async (_label, override, code) => {
    await expectReject(
      () =>
        verifyTenantRuntimeRestrictionCommand(
          signedCommand(payload(override)),
          publicKeyPem,
          expectations
        ),
      code
    );
  });

  it.each(['restrict', 'prepare_release', 'activate'] as const)(
    'accepts the typed %s transition for the future coordinator',
    (action) => {
      expect(
        verifyTenantRuntimeRestrictionCommand(
          signedCommand(payload({ action })),
          publicKeyPem,
          expectations
        ).command.action
      ).toBe(action);
    }
  );

  it('rejects an installation authority that no longer matches the signed bootstrap', async () => {
    await expectReject(
      () =>
        verifyTenantRuntimeRestrictionCommand(signedCommand(), publicKeyPem, {
          ...expectations,
          currentAuthority: { ...currentAuthority, placementId: 'replacement-placement' },
        }),
      'binding_mismatch'
    );
    await expectReject(
      () =>
        verifyTenantRuntimeRestrictionCommand(signedCommand(), publicKeyPem, {
          ...expectations,
          currentAuthority: { ...currentAuthority, protocolVersion: 2 },
        }),
      'binding_mismatch'
    );
  });

  it('verifies the shared Cloud canonicalization golden fixture', () => {
    const goldenPayload = goldenFixture.payload as TenantRuntimeRestrictionCommandPayload;
    const goldenBootstrap: TenantRuntimeBootstrapPayload = {
      ...bootstrap,
      deployment_id: goldenPayload.deployment_id,
      database_incarnation_id: goldenPayload.database_incarnation_id,
      database_name: goldenPayload.database_name,
      logical_database_id: goldenPayload.logical_database_id,
      team_id: goldenPayload.team_id,
      placement_id: goldenPayload.placement_id,
      placement_revision: goldenPayload.placement_revision,
      placement_origin: goldenPayload.placement_origin,
    };
    const goldenAuthority: TenantRuntimeCurrentAuthority = {
      ...currentAuthority,
      deploymentId: goldenPayload.deployment_id,
      databaseIncarnationId: goldenPayload.database_incarnation_id,
      databaseName: goldenPayload.database_name,
      logicalDatabaseId: goldenPayload.logical_database_id,
      teamId: goldenPayload.team_id,
      placementId: goldenPayload.placement_id,
      placementRevision: goldenPayload.placement_revision,
      placementOrigin: goldenPayload.placement_origin,
    };
    expect(
      canonicalizeSignedTenantRuntimeRestrictionCommand(goldenFixture.key_id, goldenPayload)
    ).toBe(goldenFixture.canonical);
    expect(
      verifyTenantRuntimeRestrictionCommand(
        {
          key_id: goldenFixture.key_id,
          payload: goldenPayload,
          signature: goldenFixture.signature,
        },
        goldenFixture.public_key_pem,
        {
          bootstrap: goldenBootstrap,
          currentAuthority: goldenAuthority,
          expectedKeyId: goldenFixture.key_id,
          expectedControllerId: goldenPayload.controller_id,
        }
      ).command
    ).toMatchObject({
      controllerId: goldenPayload.controller_id,
      placementId: goldenPayload.placement_id,
      operationId: goldenPayload.operation_id,
      revision: goldenPayload.revision,
      action: goldenPayload.action,
    });
  });
});
