/** Real loader, registry, runtime, repositories and registered services; only external inventory/HTTP are fixtures. */
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { type AgorConfig, MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256 } from '@agor/core/config';
import {
  createTenantScopedDatabaseProxy,
  executeRaw,
  MCPManagedOAuthInvalidationRepository,
  MCPServerRepository,
  readManagedOAuthSchemaDigest,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  setMCPEgressGatewayMode,
  sql,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import {
  type HookContext,
  MCP_OAUTH_JWS_TYPES,
  MCP_OAUTH_ROUTES,
  type MCPCatalogEntry,
  type MCPServer,
  type McpOAuthFreshPilotEnrollment,
  type McpOAuthOwner,
  McpOAuthSenderClaimsSchema,
  mcpOAuthEgressAudience,
  mcpOAuthFreshPilotEnrollmentDigest,
  mcpOAuthReceiptAudience,
  mcpOAuthSha256,
  type UserID,
} from '@agor/core/types';
import { safeOutboundFetch } from '@agor/core/utils/safe-outbound-fetch';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { managedCommit } from '../../../../packages/core/src/db/test-support/managed-oauth-fixture';
import {
  createOwnedPostgres,
  type OwnedPostgres,
} from '../../../../packages/core/src/db/test-support/owned-postgres';
import projection from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/projection-results.json';
import * as managedBootTime from '../mcp-egress/managed-boot-time';
import { createRegisteredMCPCatalogConnectService } from '../register-routes';
import { type RegisterServicesContext, registerMCPServices } from '../register-services';
import { createMcpServerWriteAuthorizationHook } from '../utils/mcp-server-authorization';
import {
  createManagedOAuthServices,
  type ManagedOAuthServices,
} from './mcp-oauth-managed-composition';
import {
  SYNTHETIC_PILOT_POD_UID,
  syntheticFreshPilotEnrollment,
} from './test-support/managed-pilot-enrollment';

// This sandbox mounts / as unmapped uid 65534. Normalize ONLY that test mount's
// owner observation; retain the real deployment reader's path/mode/size/key checks.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    lstatSync: (
      path: Parameters<typeof fs.lstatSync>[0],
      options?: Parameters<typeof fs.lstatSync>[1]
    ) => {
      const stat = fs.lstatSync(path, options);
      if (String(path) === '/' && stat && stat.uid === 65534) stat.uid = 0;
      return stat;
    },
  };
});
vi.mock('@agor/core/utils/safe-outbound-fetch', () => ({ safeOutboundFetch: vi.fn() }));
vi.mock('@agor/core/mcp-catalog', async (original) => ({
  ...(await original<typeof import('@agor/core/mcp-catalog')>()),
  loadCatalog: async () => catalog,
}));
const profiles = [projection.valid.profile, projection.valid.public_profile].map(
  (profile, index) => ({
    ...profile,
    catalog_entry_name: `org.example/fake-${index}`,
    profile_version: '1',
  })
);
const catalog = profiles.map((profile, index) => ({
  name: profile.catalog_entry_name,
  title: `Fake provider ${index}`,
  description: 'Synthetic integration provider',
  remote_url: profile.exact_resource_uri,
  transport: 'streamable-http',
  auth_type: 'oauth',
  permission_disclosure: 'Synthetic provider access only',
})) as MCPCatalogEntry[];
const master = 'synthetic-composition-test-master';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const incarnation = projection.valid.capabilities.recovery_incarnation;
const issuer = 'https://worker.example/';

describe
  .skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')
  .each(['legacy', 'fresh-pilot'] as const)(
  'registered managed production composition on owned nonowner PostgreSQL: %s',
  (admissionKind) => {
    let owned: OwnedPostgres;
    let directory: string;
    let monitor: ReturnType<typeof setInterval>;
    let services: ManagedOAuthServices;
    let makeServices: () => ReturnType<typeof createManagedOAuthServices>;
    let app: Application;
    let tenant: string;
    let userId: UserID;
    let otherId: UserID;
    let config: AgorConfig;
    let freshPilot: McpOAuthFreshPilotEnrollment | undefined;
    let callbackReady = false;
    let workerUnavailable = false;
    let publish: () => void;
    const committed: Array<{ server: MCPServer; authorization: string }> = [];
    const capabilities = { ...projection.valid.capabilities, profile_versions: profiles };
    const transactions = new Map<string, McpOAuthOwner>();
    const calls: string[] = [];
    const jwt = (claims: unknown, kind: 'receipt' | 'use') => {
      const encoded = [{ alg: 'RS256', typ: MCP_OAUTH_JWS_TYPES[kind], kid: 'worker' }, claims]
        .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
        .join('.');
      return `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), pair.privateKey).toString('base64url')}`;
    };
    beforeAll(async () => {
      vi.stubEnv('AGOR_MASTER_SECRET', master);
      owned = await createOwnedPostgres();
      const db = createTenantScopedDatabaseProxy(owned.db);
      const digest = await readManagedOAuthSchemaDigest(owned.db);
      directory = mkdtempSync(resolve(realpathSync(process.cwd()), '.managed-integration-'));
      const write = (name: string, value: string) => {
        writeFileSync(resolve(directory, `${name}.next`), value, { mode: 0o600 });
        renameSync(resolve(directory, `${name}.next`), resolve(directory, name));
      };
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      publish = () => {
        const now = Date.now(); // TEST monitor only: not a production clock assurance.
        write(
          'clock.json',
          JSON.stringify({
            version: 1,
            boot_id: boot,
            monotonic_ms: Number(process.hrtime.bigint()) / 1e6,
            ...(freshPilot ? { boottime_ms: managedBootTime.readManagedBootTimeMs() } : {}),
            utc_ms: now,
            local_uncertainty_ms: 1,
            worker_uncertainty_ms: freshPilot?.issuer_uncertainty_ms ?? 1,
            synchronized: true,
          })
        );
        write(
          'cell.json',
          JSON.stringify({
            cell_id: 'cell',
            cell_authority_epoch: '1',
            recovery_incarnation: incarnation,
            release_sha: 'a'.repeat(40),
            schema_digest: digest,
            protocol_version: 1,
            binding_version: 1,
            enforcement_version: 1,
            replicas: [
              {
                replica_id: freshPilot ? SYNTHETIC_PILOT_POD_UID : 'replica',
                release_sha: 'a'.repeat(40),
                schema_digest: digest,
                protocol_version: 1,
                binding_version: 1,
                enforcement_version: 1,
                gateway_mode: 'enforced',
              },
            ],
            expected_replica_count: 1,
            pre_gateway_executors_terminated: !freshPilot,
            ...(freshPilot ? { fresh_pilot: freshPilot } : {}),
            attestation_digest: 'c'.repeat(64),
            approval_reference: 'synthetic-only',
            observed_at: now - 1,
            valid_until: now + 60000,
          })
        );
      };
      write('sender.pem', pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
      write(
        'keys.json',
        JSON.stringify({
          issuer,
          keys: [
            {
              kid: 'worker',
              public_key_pem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
            },
          ],
        })
      );
      config = {
        database: { dialect: 'postgresql' },
        managed_mcp_oauth: {
          enabled: true,
          new_starts: true,
          exchange: true,
          refresh: true,
          use_authorization_issuance: true,
          revocation: true,
          broker_origin: 'https://worker.example',
          worker_issuer: issuer,
          environment: 'staging',
          region: 'us-west-2',
          cell_id: 'cell',
          credential_id: 'sender',
          sender_key_id: 'sender',
          sender_private_key_path: resolve(directory, 'sender.pem'),
          worker_public_keyring_path: resolve(directory, 'keys.json'),
          clock_health_path: resolve(directory, 'clock.json'),
          cell_evidence_path: resolve(directory, 'cell.json'),
          contract_sha256: MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256,
        },
      };
      if (admissionKind === 'fresh-pilot') {
        // Declared TEST operator provenance only; real loader/files, actual
        // schema/role, composition, repositories and signed-use checks remain.
        freshPilot = syntheticFreshPilotEnrollment(config);
        config.managed_mcp_oauth!.fresh_pilot_enrollment_sha256 =
          mcpOAuthFreshPilotEnrollmentDigest(freshPilot);
      }
      publish();
      monitor = setInterval(publish, 100);
      vi.mocked(safeOutboundFetch).mockImplementation(async (url, options) => {
        await options?.assertCurrent?.();
        const target = new URL(String(url));
        expect(target.origin).toBe('https://worker.example');
        const authorization = new Headers(options?.headers).get('authorization');
        const [header, payload, signature] = authorization!.slice('Bearer '.length).split('.');
        expect(
          verify(
            'RSA-SHA256',
            Buffer.from(`${header}.${payload}`),
            pair.publicKey,
            Buffer.from(signature, 'base64url')
          )
        ).toBe(true);
        expect(JSON.parse(Buffer.from(header, 'base64url').toString()).typ).toBe(
          MCP_OAUTH_JWS_TYPES.sender
        );
        const sender = McpOAuthSenderClaimsSchema.parse(
          JSON.parse(Buffer.from(payload, 'base64url').toString())
        );
        expect(sender.target_uri).toBe(String(url));
        expect(sender.body_sha256).toBe(mcpOAuthSha256(String(options?.body)));
        expect(sender.cell_id).toBe('cell');
        expect(sender.exp * 1000).toBeGreaterThan(Date.now());
        const path = target.pathname;

        const body = JSON.parse(String(options?.body));
        calls.push(path);
        let result: unknown;
        if (path === MCP_OAUTH_ROUTES.capabilities && workerUnavailable)
          return new Response('{}', {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        if (path === MCP_OAUTH_ROUTES.capabilities) result = capabilities;
        else if (path === MCP_OAUTH_ROUTES.authority) {
          const { protocol_version: _, operation_id: __, ...selectors } = body;
          result = {
            protocol_version: 1,
            owner: {
              ...selectors,
              environment: 'staging',
              residency_region: 'us-west-2',
              recovery_incarnation: incarnation,
              membership_id: 'membership',
              cell_id: 'cell',
              data_plane_id: 'plane',
              placement_epoch: '1',
              identity_epoch: '1',
              user_identity_epoch: '1',
              cell_authority_epoch: '1',
              data_plane_authority_epoch: '1',
            },
          };
        } else if (path === MCP_OAUTH_ROUTES.prepare) {
          const id = randomUUID();
          transactions.set(id, body.owner);
          result = {
            protocol_version: 1,
            transaction_id: id,
            cancel_epoch: '0',
            expires_at: Date.now() + 600000,
          };
        } else if (path === MCP_OAUTH_ROUTES.activate.replace(':id', body.transaction_id))
          result = {
            protocol_version: 1,
            transaction_id: body.transaction_id,
            intent_url: `https://cloud.example/mcp-oauth/continue#ticket=${'T'.repeat(43)}`,
            expires_at: Date.now() + 600000,
          };
        else if (path === MCP_OAUTH_ROUTES.return_ticket) {
          const entry = [...transactions].find(
            ([, owner]) => owner.attempt_id === body.owner.attempt_id
          );
          result = { protocol_version: 1, transaction_id: entry![0], owner: body.owner };
        } else if (path.endsWith('/status'))
          result = {
            protocol_version: 1,
            transaction_id: body.transaction_id,
            owner: body.owner,
            status: callbackReady ? 'callback_ready' : 'waiting',
            cancel_epoch: '0',
            expires_at: Date.now() + 600000,
          };
        else if (path.endsWith('/exchange')) {
          const commit = managedCommit(body.owner, body.claim);
          const metadata = commit.metadata;
          metadata.operation_id = body.operation_id;
          metadata.use_claims = {
            ...metadata.use_claims,
            operation_id: body.operation_id,
            iss: issuer,
            aud: mcpOAuthEgressAudience(body.owner),
          };
          metadata.use_authorization = jwt(metadata.use_claims, 'use');
          metadata.receipt_claims = {
            ...metadata.receipt_claims,
            operation_id: body.operation_id,
            iss: issuer,
            aud: mcpOAuthReceiptAudience(body.owner),
            use_authorization_digest: mcpOAuthSha256(metadata.use_authorization),
          };
          metadata.signed_receipt = jwt(metadata.receipt_claims, 'receipt');
          result = {
            protocol_version: 1,
            status: 'succeeded',
            operation_id: body.operation_id,
            owner: body.owner,
            claim: body.claim,
            receipt_id: metadata.receipt_id,
            handle: metadata.handle,
            handle_epoch: metadata.handle_epoch,
            sequence: '0',
            next_sequence: metadata.next_sequence,
            issued_at: metadata.receipt_claims.issued_at,
            expires_at: metadata.receipt_claims.expires_at,
            tokens: commit.tokens,
            signed_receipt: metadata.signed_receipt,
            use_authorization: metadata.use_authorization,
          };
        } else if (path.endsWith('/ack')) result = { protocol_version: 1, acknowledged: true };
        else throw new Error(`Unexpected synthetic worker operation ${path}`);
        return new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        });
      });
      const serviceOptions: Parameters<typeof createManagedOAuthServices>[0] = {
        db,
        config,
        releaseSha: 'a'.repeat(40),
        replicaId: freshPilot ? SYNTHETIC_PILOT_POD_UID : 'replica',
        podUid: freshPilot ? SYNTHETIC_PILOT_POD_UID : undefined,
        podNamespace: freshPilot?.namespace,
        runtimeConfigDigest: freshPilot?.runtime_config_digest,
        externalLaunchProvider: {
          enabled: true,
          providerId: 'cloud',
          issuer: 'https://cloud.example/',
        } as Parameters<typeof createManagedOAuthServices>[0]['externalLaunchProvider'],
      };
      makeServices = () => createManagedOAuthServices(serviceOptions);
      services = (await makeServices())!;
      expect(services).not.toBeNull();
      tenant = `composition-${randomUUID()}`;
      await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
        const users = new UsersRepository(scoped);
        userId = (await users.create({ email: `${randomUUID()}@example.test`, role: 'admin' }))
          .user_id;
        otherId = (await users.create({ email: `${randomUUID()}@example.test`, role: 'admin' }))
          .user_id;
        await executeRaw(
          scoped,
          sql`INSERT INTO public.user_external_identities (tenant_id,identity_key,user_id,provider,issuer,subject,last_login_at,created_at,updated_at) VALUES (${tenant},${randomUUID()},${userId},'cloud','https://cloud.example/','cloud-subject',clock_timestamp(),clock_timestamp(),clock_timestamp())`
        );
        await setMCPEgressGatewayMode(scoped, 'enforced');
      });
      app = feathers();
      await registerMCPServices({
        db,
        app: app as never,
        config,
        jwtSecret: 'synthetic',
        daemonUrl: 'https://cell.example',
        bundledUiAvailable: false,
        DAEMON_PORT: 3030,
        UI_PORT: 5173,
        allowSuperadmin: false,
        requireAuth: async (context) => context,
        deployment: {} as RegisterServicesContext['deployment'],
        mcpManagedOAuthServices: services,
        mcpManagedOAuthRuntime: services.runtime,
        mcpOAuthPendingFlowAuthority: services.flows,
        mcpOAuthCallbackUrl: 'https://cell.example/mcp-servers/oauth-callback',
      });
      app.service('mcp-servers').hooks({
        around: {
          create: [
            async (context: HookContext, next: () => Promise<void>) =>
              runWithTenantDatabaseScope(db, context.params.tenant?.tenant_id, next),
          ],
        },
        before: { create: [createMcpServerWriteAuthorizationHook(db)] },
      } as never);
      app.use(
        'mcp-catalog/connect',
        createRegisteredMCPCatalogConnectService(app as never, db, services)
      );
    }, 120000);
    afterAll(async () => {
      services?.stop();
      clearInterval(monitor);
      await owned?.dispose();
      if (directory) rmSync(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }, 30000);
    const params = (caller = userId) => ({
      provider: 'rest',
      user: { user_id: caller, role: 'admin' },
      tenant: { tenant_id: tenant, source: 'static' },
      headers: { origin: 'https://cell.example' },
    });
    const invoke = <T>(work: () => Promise<T>) => runWithTenantContext(tenant, work);
    const read = <T>(work: () => Promise<T>) => runWithTenantDatabaseScope(owned.db, tenant, work);
    it.each([0, 1])(
      'runs provider %i through real start/return/pending authority without browser-success inference',
      async (index) => {
        callbackReady = false;
        const entry = catalog[index];
        const readiness = await services.managedReadiness(entry, params() as never);
        expect(readiness.available).toBe(true);
        const profile = services.registry.resolveEntry(entry);
        const old = await runWithTenantDatabaseScope(owned.db, tenant, (scoped) =>
          new MCPServerRepository(scoped).create({
            name: `old-direct-${index}`,
            url: entry.remote_url!,
            transport: 'http',
            scope: 'global',
            owner_user_id: userId,
            enabled: true,
            auth: { type: 'oauth', oauth_mode: 'per_user' },
          })
        );
        const installed = await invoke(() =>
          app.service('mcp-catalog/connect').create(
            {
              catalog_key: entry.name,
              oauth_client_mode: 'cloud_managed_v1',
              acknowledged_disclosure: entry.permission_disclosure,
              acknowledged_managed_disclosure:
                'disclosure' in readiness ? readiness.disclosure : '',
            },
            params()
          )
        );
        const server = (await runWithTenantDatabaseScope(owned.db, tenant, (scoped) =>
          new MCPServerRepository(scoped).findById(installed.mcp_server.mcp_server_id)
        )) as MCPServer;
        expect(server.mcp_server_id).not.toBe(old.mcp_server_id);
        expect(server.owner_user_id).toBe(userId);
        expect(
          await runWithTenantDatabaseScope(owned.db, tenant, (scoped) =>
            new MCPServerRepository(scoped).findById(old.mcp_server_id)
          )
        ).toEqual(old);
        const nonce = randomUUID();
        const start = await invoke(() =>
          app
            .service('mcp-servers/oauth-start')
            .create({ mcp_server_id: server.mcp_server_id, client_nonce: nonce }, params())
        );
        expect(start.success, JSON.stringify(start)).toBe(true);
        expect(start.transaction_id).toBeTruthy();
        await expect(
          invoke(() =>
            app.service('mcp-servers/oauth-managed-return').create(
              {
                transaction_id: start.transaction_id,
                ticket: 'R'.repeat(43),
                client_nonce: randomUUID(),
              },
              params()
            )
          )
        ).rejects.toThrow();
        await expect(
          invoke(() =>
            app.service('mcp-servers/oauth-managed-return').create(
              {
                transaction_id: start.transaction_id,
                ticket: 'R'.repeat(43),
                client_nonce: nonce,
              },
              params(otherId)
            )
          )
        ).rejects.toThrow();
        const returned = await invoke(() =>
          app
            .service('mcp-servers/oauth-managed-return')
            .create(
              { transaction_id: start.transaction_id, ticket: 'R'.repeat(43), client_nonce: nonce },
              params()
            )
        );
        expect(returned).toEqual({ accepted: true, attempt_id: start.attempt_id });
        const pending = await invoke(() =>
          app.service('mcp-servers/oauth-attempt-status').get(start.attempt_id, params())
        );
        expect(pending.status).toBe('pending');
        expect(
          (await read(() => app.service('mcp-servers/oauth-status').find(params())))
            .authenticated_server_ids
        ).not.toContain(server.mcp_server_id);
        callbackReady = true;
        const completed = await invoke(() =>
          app.service('mcp-servers/oauth-attempt-status').get(start.attempt_id, params())
        );
        expect(completed.status).toBe('succeeded');
        const metadata = await runWithTenantDatabaseScope(owned.db, tenant, (scoped) =>
          new UserMCPOAuthTokenRepository(scoped).getManagedMetadata(userId, server.mcp_server_id)
        );
        expect(metadata?.owner.profile_id).toBe(profile.reference.profile_id);
        // A committed grant still cannot be advertised/used until local invalidations are ready.
        await runWithTenantDatabaseScope(owned.db, tenant, async (scoped) => {
          const repo = new MCPManagedOAuthInvalidationRepository(scoped);
          const scope = {
            tenant_id: tenant,
            cell_id: 'cell',
            environment: 'staging' as const,
            residency_region: 'us-west-2' as const,
            recovery_incarnation: incarnation,
          };
          const checkpoint = await repo.read(scope);
          await repo.applyPage(
            scope,
            checkpoint.cursor,
            {
              protocol_version: 1,
              recovery_incarnation: incarnation,
              snapshot_required: false,
              snapshot_complete: true,
              next_cursor: '0',
              items: [],
            },
            { snapshot: true }
          );
        });
        await runWithTenantDatabaseScope(owned.db, tenant, async (scoped) => {
          const grant = await new UserMCPOAuthTokenRepository(scoped).getCatalogGrantAuthority(
            userId,
            server.mcp_server_id
          );
          expect(grant).not.toBeNull();
          expect(await services.managedValidator(scoped, server, grant!)).toBe(true);
          for (const substituted of [
            { ...grant!, mcp_server_id: randomUUID() },
            { ...grant!, grant_binding_version: 4 },
            { ...grant!, grant_binding_fingerprint: '0'.repeat(64) },
            { ...grant!, oauth_client_id: 'foreign-client' },
            { ...grant!, oauth_token_endpoint: 'https://foreign.example/token' },
          ])
            expect(
              await services.managedValidator(scoped, server, substituted as typeof grant & {})
            ).toBe(false);
        });

        await runWithTenantDatabaseScope(owned.db, tenant, async (scoped) => {
          const records = await new UserMCPOAuthTokenRepository(scoped).listStatusForSubject(
            userId
          );
          const record = records.find((item) => item.mcp_server_id === server.mcp_server_id);
          expect(record).toBeDefined();
          expect(await services.managedValidator(scoped, server, record!)).toBe(true);
        });
        const status = await read(() => app.service('mcp-servers/oauth-status').find(params()));
        expect(status.authenticated_server_ids).toContain(server.mcp_server_id);
        const authorization = await invoke(() =>
          services.grantAccess.acquireAuthorization({
            tenantId: tenant,
            userId,
            server,
            assertCurrent: () => {},
          })
        );
        expect(authorization).toMatch(/^Bearer synthetic-access-/);
        await runWithTenantDatabaseScope(owned.db, tenant, (scoped) =>
          services.grantAccess.assertManagedUse({
            tenantDb: scoped,
            tenantId: tenant,
            userId,
            server,
            authorization,
          })
        );
        await expect(
          runWithTenantDatabaseScope(owned.db, tenant, (scoped) =>
            services.grantAccess.assertManagedUse({
              tenantDb: scoped,
              tenantId: tenant,
              userId,
              server,
              authorization: 'Bearer substituted',
            })
          )
        ).rejects.toThrow();

        await expect(
          invoke(() =>
            app
              .service('mcp-servers/oauth-auth-headers')
              .create({ mcp_server_ids: [server.mcp_server_id] }, params())
          )
        ).rejects.toThrow();
        expect(calls).toContain(MCP_OAUTH_ROUTES.authority);
        committed.push({ server, authorization });
      }
    );
    it('keeps acquisition through outage and proactive refresh, denies explicit policy and original hour expiry', async () => {
      expect(committed).toHaveLength(2);
      const realDate = Date.now.bind(Date);
      const realMonotonic = process.hrtime.bigint.bind(process.hrtime);
      const realBootTime = managedBootTime.readManagedBootTimeMs;
      let elapsed = 0;
      // Advance both independent test-monitor domains equally. The real clock
      // reader, safety checks, cohort reader and signed permit validator remain in use.
      const date = vi.spyOn(Date, 'now').mockImplementation(() => realDate() + elapsed);
      const monotonic = vi
        .spyOn(process.hrtime, 'bigint')
        .mockImplementation(() => realMonotonic() + BigInt(elapsed) * 1000000n);
      const bootTime = vi
        .spyOn(managedBootTime, 'readManagedBootTimeMs')
        .mockImplementation(() => realBootTime() + elapsed);
      const assertUse = ({ server, authorization }: (typeof committed)[number]) =>
        invoke(() =>
          services.grantAccess.assertManagedUse({
            tenantDb: createTenantScopedDatabaseProxy(owned.db),
            tenantId: tenant,
            server,
            userId,
            authorization,
          })
        );
      const dispatches = calls.filter(
        (path) => path.endsWith('/exchange') || path.endsWith('/refresh')
      ).length;
      try {
        workerUnavailable = true;
        for (const offset of [60000, 180000, 59 * 60000]) {
          elapsed = offset;
          publish();
          await expect(services.registry.refresh()).rejects.toThrow();
          for (const grant of committed) {
            await assertUse(grant);
            // Actual gateway acquisition, including the proactive refresh
            // threshold. Only a CAS-certified local no-dispatch may retain the
            // unchanged token and original signed authorization.
            const authorization = await invoke(() =>
              services.grantAccess.acquireAuthorization({
                tenantId: tenant,
                userId,
                server: grant.server,
                assertCurrent: () => {},
              })
            );
            expect(authorization).toBe(grant.authorization);
          }
          expect(() => services.registry.resolve(committed[0]!.server, 'refresh')).toThrow();
          expect(() => services.registry.resolveEntry(catalog[0])).toThrow();
        }
        workerUnavailable = false;
        capabilities.available = false;
        capabilities.profile_versions = [];
        await expect(services.registry.refresh()).rejects.toThrow();
        await expect(assertUse(committed[0]!)).rejects.toThrow();
        capabilities.available = true;
        capabilities.profile_versions = profiles;
        await services.registry.refresh();
        await assertUse(committed[0]!);
        workerUnavailable = true;
        elapsed = 61 * 60000;
        publish();
        await expect(services.registry.refresh()).rejects.toThrow();
        for (const grant of committed)
          await expect(assertUse(grant)).rejects.toMatchObject({
            code: 'managed_authority_expired',
          });
        expect(
          calls.filter((path) => path.endsWith('/exchange') || path.endsWith('/refresh')).length
        ).toBe(dispatches);
      } finally {
        date.mockRestore();
        monotonic.mockRestore();
        bootTime.mockRestore();
        workerUnavailable = false;
      }
    });
    if (admissionKind === 'fresh-pilot') {
      it('denies the first actual managed hop after suspend before the monitor updates, also after restart', async () => {
        clearInterval(monitor);
        publish();
        const resumed = (await makeServices())!;
        const assertUse = () =>
          invoke(() =>
            resumed.grantAccess.assertManagedUse({
              tenantDb: createTenantScopedDatabaseProxy(owned.db),
              tenantId: tenant,
              server: committed[0]!.server,
              userId,
              authorization: committed[0]!.authorization,
            })
          );
        try {
          await assertUse();
          const before = calls.length;
          const path = resolve(directory, 'clock.json');
          const sample = JSON.parse(readFileSync(path, 'utf8'));
          // Only boot-time age advances: UTC/process-monotonic still look fresh.
          // This is synthetic suspend evidence, not a real host suspension.
          sample.boottime_ms -= 60_000;
          writeFileSync(`${path}.next`, JSON.stringify(sample), { mode: 0o600 });
          renameSync(`${path}.next`, path);
          await expect(assertUse()).rejects.toThrow();
          await expect(
            invoke(() =>
              resumed.grantAccess.acquireAuthorization({
                tenantId: tenant,
                userId,
                server: committed[0]!.server,
                assertCurrent: () => {},
              })
            )
          ).rejects.toThrow();
          await expect(makeServices()).rejects.toThrow();
          expect(calls).toHaveLength(before);
          publish();
          await expect(assertUse()).rejects.toThrow(); // Unsafe process remains latched.
        } finally {
          resumed.stop();
        }
      });
    }
  }
);
