import { generateKeyPairSync, sign } from 'node:crypto';
import { createDatabase, TenantRestrictionUnsupportedError } from '@agor/core/db';
import { describe, expect, it, vi } from 'vitest';
import type { TenantRuntimeBootstrapPayload } from './tenant-runtime-bootstrap.js';
import type { TenantRuntimeCurrentAuthority } from './tenant-runtime-current-authority.js';
import {
  canonicalizeSignedTenantRuntimeRestrictionCommand,
  type SignedTenantRuntimeRestrictionCommand,
  type TenantRuntimeRestrictionCommandError,
  type TenantRuntimeRestrictionCommandPayload,
} from './tenant-runtime-restriction-command.js';
import {
  consumeTenantRuntimeRestrictionCommand,
  type TenantRuntimeRestrictionConsumerError,
  type TenantRuntimeRestrictionTenantBinding,
  TenantRuntimeRestrictionTenantBindingSchema,
  type TenantRuntimeRestrictionTenantResolver,
  type TenantRuntimeRestrictionUnsupportedError,
} from './tenant-runtime-restriction-consumer.js';

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
    operation_id: 'team-suspension-operation-a',
    revision: 1,
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

function bindingFor(
  commandPayload: TenantRuntimeRestrictionCommandPayload,
  overrides: Partial<TenantRuntimeRestrictionTenantBinding> = {}
): TenantRuntimeRestrictionTenantBinding {
  return {
    workspaceId: commandPayload.tenant_id,
    tenantId: commandPayload.tenant_id,
    teamId: commandPayload.team_id,
    deploymentId: commandPayload.deployment_id,
    databaseIncarnationId: commandPayload.database_incarnation_id,
    databaseName: commandPayload.database_name,
    logicalDatabaseId: commandPayload.logical_database_id,
    placementId: commandPayload.placement_id,
    placementOrigin: commandPayload.placement_origin,
    placementRevision: commandPayload.placement_revision,
    ...overrides,
  };
}

function inputFor(
  commandPayload: TenantRuntimeRestrictionCommandPayload,
  resolveTenant: TenantRuntimeRestrictionTenantResolver
) {
  return {
    db: createDatabase({ url: ':memory:' }),
    raw: signedCommand(commandPayload),
    publicKey: publicKeyPem,
    expectations,
    resolveTenant,
  };
}

async function expectVerifierReject(
  operation: () => unknown,
  code: TenantRuntimeRestrictionCommandError['code']
): Promise<void> {
  await expect(Promise.resolve().then(operation)).rejects.toMatchObject({
    name: 'TenantRuntimeRestrictionCommandError',
    code,
  });
}

describe('tenant runtime restriction authenticated consumer seam', () => {
  it.each([
    ['restrict', payload()],
    [
      'prepare_release',
      payload({
        operation_id: 'team-suspension-release-operation',
        revision: 2,
        action: 'prepare_release',
      }),
    ],
  ] as const)(
    'passes a valid %s through verification and the existing typed writer',
    async (_action, commandPayload) => {
      const resolveTenant = vi.fn<TenantRuntimeRestrictionTenantResolver>(async ({ payload }) =>
        bindingFor(payload)
      );

      // SQLite is intentionally unsupported by the existing hosted restriction
      // writer. Reaching that typed boundary proves this seam did not bypass
      // signature, installation, or tenant binding checks before applying it.
      await expect(
        consumeTenantRuntimeRestrictionCommand(inputFor(commandPayload, resolveTenant))
      ).rejects.toBeInstanceOf(TenantRestrictionUnsupportedError);
      expect(resolveTenant).toHaveBeenCalledOnce();
      const resolverInput = resolveTenant.mock.calls[0]![0];
      expect(resolverInput).toMatchObject({
        tenantId: commandPayload.tenant_id,
        command: {
          controllerId: commandPayload.controller_id,
          operationId: commandPayload.operation_id,
          revision: commandPayload.revision,
          action: commandPayload.action,
        },
        payload: commandPayload,
      });
      expect(Object.isFrozen(resolverInput.command)).toBe(true);
      expect(Object.isFrozen(resolverInput.payload)).toBe(true);
    }
  );

  it('fails closed when the authoritative tenant/Workspace binding is missing or unresolved', async () => {
    const resolveTenant = vi.fn<TenantRuntimeRestrictionTenantResolver>().mockResolvedValue(null);

    await expect(
      consumeTenantRuntimeRestrictionCommand(inputFor(payload(), resolveTenant))
    ).rejects.toMatchObject({
      name: 'TenantRuntimeRestrictionConsumerError',
      code: 'tenant_binding_unavailable',
    } satisfies Partial<TenantRuntimeRestrictionConsumerError>);
    expect(resolveTenant).toHaveBeenCalledOnce();
  });

  it('fails closed when an injected resolver returns no binding value', async () => {
    const resolveTenant = vi
      .fn<TenantRuntimeRestrictionTenantResolver>()
      .mockResolvedValue(undefined as never);

    await expect(
      consumeTenantRuntimeRestrictionCommand(inputFor(payload(), resolveTenant))
    ).rejects.toMatchObject({
      name: 'TenantRuntimeRestrictionConsumerError',
      code: 'tenant_binding_unavailable',
    } satisfies Partial<TenantRuntimeRestrictionConsumerError>);
  });

  it('rejects an invalid internal configuration before resolving a tenant', async () => {
    const resolveTenant = undefined as never as TenantRuntimeRestrictionTenantResolver;

    await expect(
      consumeTenantRuntimeRestrictionCommand(inputFor(payload(), resolveTenant))
    ).rejects.toMatchObject({
      name: 'TenantRuntimeRestrictionConsumerError',
      code: 'invalid_configuration',
    } satisfies Partial<TenantRuntimeRestrictionConsumerError>);
  });

  it.each([
    ['workspace moved', { workspaceId: 'workspace-moved' }],
    ['tenant moved', { tenantId: 'workspace-moved' }],
    ['placement moved', { placementId: 'placement-moved' }],
    ['database incarnation changed', { databaseIncarnationId: 'db-incarnation-moved' }],
    ['logical database changed', { logicalDatabaseId: 'logical-db-moved' }],
  ] as const)('%s fails closed before the writer', async (_label, bindingOverride) => {
    const commandPayload = payload();
    const resolveTenant = vi
      .fn<TenantRuntimeRestrictionTenantResolver>()
      .mockResolvedValue(bindingFor(commandPayload, bindingOverride));

    await expect(
      consumeTenantRuntimeRestrictionCommand(inputFor(commandPayload, resolveTenant))
    ).rejects.toMatchObject({
      name: 'TenantRuntimeRestrictionConsumerError',
      code: 'tenant_binding_mismatch',
    } satisfies Partial<TenantRuntimeRestrictionConsumerError>);
  });

  it('turns resolver errors into a typed fail-closed result', async () => {
    const resolveTenant = vi
      .fn<TenantRuntimeRestrictionTenantResolver>()
      .mockRejectedValue(new Error('resolver detail must not become authority'));

    await expect(
      consumeTenantRuntimeRestrictionCommand(inputFor(payload(), resolveTenant))
    ).rejects.toMatchObject({
      name: 'TenantRuntimeRestrictionConsumerError',
      code: 'tenant_binding_unavailable',
    } satisfies Partial<TenantRuntimeRestrictionConsumerError>);
  });

  it('rejects activate as typed unsupported before tenant resolution or mutation', async () => {
    const resolveTenant = vi.fn<TenantRuntimeRestrictionTenantResolver>();
    const command = signedCommand(payload({ action: 'activate' }));

    await expect(
      consumeTenantRuntimeRestrictionCommand({
        ...inputFor(command.payload, resolveTenant),
        raw: command,
      })
    ).rejects.toMatchObject({
      name: 'TenantRuntimeRestrictionUnsupportedError',
      code: 'unsupported_action',
      action: 'activate',
    } satisfies Partial<TenantRuntimeRestrictionUnsupportedError>);
    expect(resolveTenant).not.toHaveBeenCalled();
  });

  it('rejects signature, bootstrap, and current-authority mismatches before resolving a tenant', async () => {
    const resolveTenant = vi.fn<TenantRuntimeRestrictionTenantResolver>();
    const command = signedCommand();

    await expectVerifierReject(
      () =>
        consumeTenantRuntimeRestrictionCommand({
          ...inputFor(command.payload, resolveTenant),
          raw: { ...command, signature: command.signature.slice(0, -1) },
        }),
      'signature_invalid'
    );
    await expectVerifierReject(
      () =>
        consumeTenantRuntimeRestrictionCommand({
          ...inputFor(command.payload, resolveTenant),
          raw: command,
          expectations: { ...expectations, bootstrap: { ...bootstrap, team_id: 'other-team' } },
        }),
      'binding_mismatch'
    );
    await expectVerifierReject(
      () =>
        consumeTenantRuntimeRestrictionCommand({
          ...inputFor(command.payload, resolveTenant),
          raw: command,
          expectations: {
            ...expectations,
            currentAuthority: { ...currentAuthority, placementRevision: 8 },
          },
        }),
      'binding_mismatch'
    );
    expect(resolveTenant).not.toHaveBeenCalled();
  });

  it('rejects controller and placement mismatches without inventing actor authority', async () => {
    const resolveTenant = vi.fn<TenantRuntimeRestrictionTenantResolver>();
    await expectVerifierReject(
      () =>
        consumeTenantRuntimeRestrictionCommand(
          inputFor(payload({ controller_id: 'other-controller' }), resolveTenant)
        ),
      'binding_mismatch'
    );
    await expectVerifierReject(
      () =>
        consumeTenantRuntimeRestrictionCommand(
          inputFor(payload({ placement_id: 'other-placement' }), resolveTenant)
        ),
      'binding_mismatch'
    );

    const command = signedCommand();
    const actorBearingPayload = { ...command.payload, actor_id: 'operator-a' };
    await expectVerifierReject(
      () =>
        consumeTenantRuntimeRestrictionCommand({
          ...inputFor(command.payload, resolveTenant),
          raw: { ...command, payload: actorBearingPayload },
        }),
      'invalid_document'
    );
    expect(resolveTenant).not.toHaveBeenCalled();
  });

  it('keeps this module as an unregistered application seam without transport or proof observers', async () => {
    const moduleExports = await import('./tenant-runtime-restriction-consumer.js');
    expect(Object.keys(moduleExports).sort()).toEqual([
      'TenantRuntimeRestrictionConsumerError',
      'TenantRuntimeRestrictionTenantBindingSchema',
      'TenantRuntimeRestrictionUnsupportedError',
      'consumeTenantRuntimeRestrictionCommand',
    ]);
  });

  it('validates the resolver binding shape strictly', () => {
    expect(
      TenantRuntimeRestrictionTenantBindingSchema.safeParse({
        ...bindingFor(payload()),
        actorId: 'not-a-runtime-field',
      }).success
    ).toBe(false);
  });
});
