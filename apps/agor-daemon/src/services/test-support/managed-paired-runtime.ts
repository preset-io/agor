/** TEST ONLY: real runtime composition with synthetic operator evidence and fixture session auth. */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import {
  type AgorConfig,
  MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256,
  resolveMultiTenancyConfig,
} from '@agor/core/config';
import {
  createTenantScopedDatabaseProxy,
  executeRaw,
  readManagedOAuthSchemaDigest,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  setMCPEgressGatewayMode,
  sql,
  UsersRepository,
} from '@agor/core/db';
import {
  errorHandler,
  feathers,
  feathersExpress,
  NotAuthenticated,
  rest,
  socketio,
} from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  HookContext,
  MCPCatalogEntry,
  McpOAuthOwner,
  McpOAuthProfileProjection,
  User,
} from '@agor/core/types';
import { type Express, json } from 'express';
import jwt from 'jsonwebtoken';
import { createOwnedPostgres } from '../../../../../packages/core/src/db/test-support/owned-postgres';
import {
  finalizeAuthenticatedConnectionAuthority,
  retireAuthenticatedConnectionAuthority,
} from '../../auth/authenticated-connection-authority';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../../auth/runtime-tokens';
import { TENANT_OWNED_SERVICE_PATHS } from '../../register-hooks';
import {
  createRegisteredMCPCatalogConnectService,
  createRegisteredMCPMemberPolicyService,
} from '../../register-routes';
import { type RegisterServicesContext, registerMCPServices } from '../../register-services';
import { createMcpServerWriteAuthorizationHook } from '../../utils/mcp-server-authorization';
import {
  AGOR_SOCKET_AUTHORITY_DISCONNECTED_EVENT,
  installSocketAuthorityId,
} from '../../utils/socket-request-authority';
import { createTenantDatabaseScopeAroundHook } from '../../utils/tenant-db-scope';
import { createManagedOAuthServices } from '../mcp-oauth-managed-composition';
import { createManagedOAuthMaintenanceServices } from '../mcp-oauth-managed-maintenance-composition';
import type { startPairedCloudProcess } from './paired-cloud-fixture';

export interface PairedManifest {
  workerOrigin: string;
  consoleOrigin: string;
  issuer: string;
  recoveryIncarnation: string;
  externalLaunchProvider: { enabled: true; providerId: string; issuer: string };
  receiptVerificationKey: { kid: string; publicKeyPem: string };
  sender: { credentialId: string; keyId: string; cellId: string; audience: string };
  profiles: McpOAuthProfileProjection[];
  catalogArtifact: string;
  catalogDigest: string;
  catalogEntries: MCPCatalogEntry[];
  tls: { chromiumArgs: string[] };
}
export const PAIRED_RUNTIME_ORIGIN = 'https://runtime.paired.test';

export async function startManagedPairedRuntime(
  cloud: Awaited<ReturnType<typeof startPairedCloudProcess>>,
  /** Installs only test transport/inventory; never replaces the runtime/grant/registry implementation. */
  installFixture: (manifest: PairedManifest) => void
) {
  const owned = await createOwnedPostgres();
  const db = createTenantScopedDatabaseProxy(owned.db);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let services: Awaited<ReturnType<typeof createManagedOAuthServices>>;
  let maintenance: Awaited<ReturnType<typeof createManagedOAuthMaintenanceServices>>;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let directory: string | undefined;
  let listener: Server | undefined;
  const app = feathersExpress(feathers());
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    services?.stop();
    await maintenance?.stop();
    if (monitor) clearInterval(monitor);
    try {
      if (listener)
        await app.teardown().catch((error: NodeJS.ErrnoException) => {
          // Socket.IO can close the shared HTTP listener before Feathers closes it.
          if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
        });
      if (listener?.listening) await new Promise<void>((done) => listener!.close(() => done()));
    } finally {
      try {
        await owned.dispose();
      } finally {
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    const manifest = (await cloud.call('start', {
      runtimeOrigin: PAIRED_RUNTIME_ORIGIN,
      senderPublicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      cellId: 'cell',
      environment: 'staging',
      region: 'us-west-2',
    })) as PairedManifest;
    installFixture(manifest);
    const digest = await readManagedOAuthSchemaDigest(owned.db);
    directory = mkdtempSync(resolve(realpathSync(process.cwd()), '.managed-paired-'));
    const path = (name: string) => resolve(directory!, name);
    const write = (name: string, value: string) => {
      writeFileSync(path(`${name}.next`), value, { mode: 0o600 });
      renameSync(path(`${name}.next`), path(name));
    };
    let attestedCellEpoch = '1';
    const publish = () => {
      const now = Date.now(); // Explicit synthetic operator monitor, not production clock assurance.
      write(
        'clock.json',
        JSON.stringify({
          version: 1,
          boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
          monotonic_ms: Number(process.hrtime.bigint()) / 1e6,
          utc_ms: now,
          local_uncertainty_ms: 1,
          worker_uncertainty_ms: 1,
          synchronized: true,
        })
      );
      write(
        'cell.json',
        JSON.stringify({
          cell_id: 'cell',
          cell_authority_epoch: attestedCellEpoch,
          recovery_incarnation: manifest.recoveryIncarnation,
          release_sha: 'b'.repeat(40),
          schema_digest: digest,
          protocol_version: 1,
          binding_version: 1,
          enforcement_version: 1,
          replicas: [
            {
              replica_id: 'paired_replica',
              release_sha: 'b'.repeat(40),
              schema_digest: digest,
              protocol_version: 1,
              binding_version: 1,
              enforcement_version: 1,
              gateway_mode: 'enforced',
            },
          ],
          expected_replica_count: 1,
          pre_gateway_executors_terminated: true,
          attestation_digest: 'd'.repeat(64),
          approval_reference: 'TEST_ONLY_PAIRED_COHORT',
          observed_at: now - 1,
          valid_until: now + 60000,
        })
      );
    };
    publish();
    monitor = setInterval(publish, 100);
    write('sender.pem', pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    write(
      'keys.json',
      JSON.stringify({
        issuer: manifest.issuer,
        keys: [
          {
            kid: manifest.receiptVerificationKey.kid,
            public_key_pem: manifest.receiptVerificationKey.publicKeyPem,
          },
        ],
      })
    );
    const config: AgorConfig = {
      database: { dialect: 'postgresql' },
      multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      managed_mcp_oauth: {
        enabled: true,
        new_starts: true,
        exchange: true,
        refresh: true,
        use_authorization_issuance: true,
        revocation: true,
        broker_origin: manifest.workerOrigin,
        worker_issuer: manifest.issuer,
        environment: 'staging',
        region: 'us-west-2',
        cell_id: 'cell',
        credential_id: manifest.sender.credentialId,
        sender_key_id: manifest.sender.keyId,
        sender_private_key_path: path('sender.pem'),
        worker_public_keyring_path: path('keys.json'),
        clock_health_path: path('clock.json'),
        cell_evidence_path: path('cell.json'),
        contract_sha256: MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256,
      },
    };
    const tenantId = randomUUID();
    let user: User;
    const cloudSubject = randomUUID();
    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      user = await new UsersRepository(scoped).create({
        email: 'paired@example.test',
        role: 'admin',
      });
      await executeRaw(
        scoped,
        sql`INSERT INTO public.user_external_identities (tenant_id,identity_key,user_id,provider,issuer,subject,last_login_at,created_at,updated_at) VALUES (${tenantId},${randomUUID()},${user.user_id},'cloud',${manifest.externalLaunchProvider.issuer},${cloudSubject},clock_timestamp(),clock_timestamp(),clock_timestamp())`
      );
      await setMCPEgressGatewayMode(scoped, 'enforced');
    });
    const seed = (await cloud.call('seed', {
      tenantId,
      userId: user!.user_id,
      cloudSubject,
      externalIdentity: {
        provider: 'cloud',
        issuer: manifest.externalLaunchProvider.issuer,
        subject: cloudSubject,
      },
    })) as { loginUrl: string; owners: { alpha: McpOAuthOwner; beta: McpOAuthOwner } };
    if (seed.owners.alpha.cell_authority_epoch !== seed.owners.beta.cell_authority_epoch)
      throw new Error('Fixture cell evidence disagrees');
    // Synthetic operator monitor observes the actual disposable Cloud cell generation.
    attestedCellEpoch = seed.owners.alpha.cell_authority_epoch;
    publish();
    services = await createManagedOAuthServices({
      db,
      config,
      releaseSha: 'b'.repeat(40),
      replicaId: 'paired_replica',
      externalLaunchProvider: manifest.externalLaunchProvider as Parameters<
        typeof createManagedOAuthServices
      >[0]['externalLaunchProvider'],
    });
    if (!services) throw new Error('Real managed runtime composition unavailable');
    services.start();
    maintenance = await createManagedOAuthMaintenanceServices({
      db,
      config,
      active: services,
      externalLaunchProvider: manifest.externalLaunchProvider as Parameters<
        typeof createManagedOAuthMaintenanceServices
      >[0]['externalLaunchProvider'],
    });

    maintenance?.start();
    const accessToken = jwt.sign(
      { sub: user!.user_id, type: 'access', tenant_id: tenantId },
      'synthetic-paired-jwt',
      {
        issuer: RUNTIME_JWT_ISSUER,
        audience: RUNTIME_JWT_AUDIENCE,
        expiresIn: '10m',
        algorithm: 'HS256',
      }
    ); // Generated fixture session only, never a provider credential.
    const connections = new WeakSet<object>();
    const requireAuth = async (context: HookContext) => {
      const validSocket = context.params.connection && connections.has(context.params.connection);
      if (!validSocket && context.params.headers?.authorization !== `Bearer ${accessToken}`)
        throw new NotAuthenticated();
      context.params.user = user!;
      context.params.tenant = { tenant_id: tenantId, source: 'static' } as never;
      if (validSocket)
        context.params.headers = (
          context.params.connection as { headers: Record<string, string | undefined> }
        ).headers;
      return context;
    };
    app.use(json());
    app.configure(rest());
    app.configure(
      socketio({}, (io) => {
        io.use((socket, next) => {
          try {
            if (socket.handshake.auth.token !== accessToken)
              return next(new Error('Fixture session required'));
            const connection = (socket as unknown as { feathers: Record<string, unknown> })
              .feathers;
            const payload = jwt.verify(accessToken, 'synthetic-paired-jwt', {
              issuer: RUNTIME_JWT_ISSUER,
              audience: RUNTIME_JWT_AUDIENCE,
              algorithms: ['HS256'],
            });
            finalizeAuthenticatedConnectionAuthority({
              connection,
              multiTenancy: resolveMultiTenancyConfig(config),
              authResult: { user: user!, authentication: { strategy: 'jwt', payload } },
            });
            connection.headers = { origin: socket.handshake.headers.origin };
            installSocketAuthorityId(connection, socket.id);
            socket.once('disconnect', () => {
              retireAuthenticatedConnectionAuthority(connection);
              app.emit(AGOR_SOCKET_AUTHORITY_DISCONNECTED_EVENT, socket.id);
            });
            connections.add(connection);
            next();
          } catch {
            next(new Error('Fixture session invalid'));
          }
        });
      })
    );
    const transactionalPaths = new Set<string>([
      ...TENANT_OWNED_SERVICE_PATHS,
      'mcp-member-policy',
    ]);
    const transactionalScope = createTenantDatabaseScopeAroundHook({
      db,
      config,
      jwtSecret: 'synthetic-paired-jwt',
    });
    const identityScope = createTenantDatabaseScopeAroundHook({
      db,
      config,
      jwtSecret: 'synthetic-paired-jwt',
      transaction: false,
    });
    app.hooks({
      around: {
        all: [
          async (context, next) =>
            (transactionalPaths.has(context.path) ? transactionalScope : identityScope)(
              context,
              next
            ),
        ],
      },
    });
    (app as unknown as Express).get('/__managed-acceptance/session', (_req, res) =>
      res.json({ accessToken, user: user! })
    );
    await registerMCPServices({
      db,
      app: app as never,
      config,
      jwtSecret: 'synthetic-paired-jwt',
      daemonUrl: PAIRED_RUNTIME_ORIGIN,
      bundledUiAvailable: true,
      DAEMON_PORT: 3030,
      UI_PORT: 5173,
      allowSuperadmin: false,
      requireAuth,
      deployment: {} as RegisterServicesContext['deployment'],
      mcpManagedOAuthServices: services,
      mcpManagedOAuthRuntime: services.runtime,
      mcpOAuthPendingFlowAuthority: services.flows,
      mcpOAuthCallbackUrl: `${PAIRED_RUNTIME_ORIGIN}/mcp-servers/oauth-callback`,
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
      createRegisteredMCPCatalogConnectService(app as never, db, services),
      { methods: ['create'] }
    );
    app.use('mcp-member-policy', createRegisteredMCPMemberPolicyService(app as never, db), {
      methods: ['find', 'patch'],
    });
    for (const name of ['mcp-catalog/connect', 'mcp-member-policy'])
      app.service(name as never).hooks({ before: { all: [requireAuth] } });
    const observations: Array<{ path: string; outcome: string }> = [];
    for (const path of [
      'mcp-catalog/connect',
      'mcp-servers/oauth-start',
      'mcp-servers/oauth-managed-return',
      'mcp-servers/oauth-attempt-status',
    ]) {
      app.service(path as never).hooks({
        after: {
          all: [
            async (context: HookContext) => {
              observations.push({
                path,
                outcome: path.endsWith('oauth-attempt-status')
                  ? String(context.result?.status)
                  : path.endsWith('oauth-start')
                    ? context.result?.success
                      ? 'started'
                      : String(context.result?.error ?? 'denied')
                    : 'connected-row',
              });
              return context;
            },
          ],
        },
        error: {
          all: [
            async (context: HookContext) => {
              observations.push({ path, outcome: context.error?.name ?? 'error' });
              return context;
            },
          ],
        },
      });
    }
    app.use(errorHandler({ logger: false }));
    listener = (await app.listen(0, '127.0.0.1')) as Server;
    if (!listener.listening)
      await new Promise<void>((done, reject) => {
        listener!.once('listening', done);
        listener!.once('error', reject);
      });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing runtime listener');
    const fixtureParams = (): AuthenticatedParams => ({
      provider: 'rest',
      user: user!,
      tenant: { tenant_id: tenantId, source: 'static' } as never,
      headers: { authorization: `Bearer ${accessToken}`, origin: PAIRED_RUNTIME_ORIGIN },
    });
    return {
      app,
      db,
      owned,
      services,
      maintenance,
      observations,
      manifest,
      seed,
      tenantId,
      user: user!,
      origin: `http://127.0.0.1:${address.port}`,
      read: (path: string, id: string) =>
        runWithTenantContext(tenantId, () => app.service(path as never).get(id, fixtureParams())),
      call: async (
        path: string,
        data: Record<string, unknown>
      ): Promise<Record<string, unknown>> => {
        if (!/^mcp-servers\/[a-z-]+$/.test(path)) throw new Error('Fixture route denied');
        const response = await fetch(`http://127.0.0.1:${address.port}/${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            origin: PAIRED_RUNTIME_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify(data),
        });
        const value = await response.json();
        if (!response.ok)
          throw Object.assign(new Error('Registered fixture request rejected'), {
            code: response.status,
          });
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Fixture response shape invalid');
        return value as Record<string, unknown>;
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
