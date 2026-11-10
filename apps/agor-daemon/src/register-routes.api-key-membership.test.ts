import { resolveExternalLaunchSettings } from '@agor/core/config';
import {
  BranchRepository,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  runMigrations,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers, feathersExpress, rest, socketio } from '@agor/core/feathers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyStrategy } from './auth/api-key-strategy';
import { setupMCPRoutes } from './mcp/server';
import { type RegisterRoutesContext, registerRoutes } from './register-routes';
import { SessionMCPServersService } from './services/session-mcp-servers';

vi.mock('./mcp/server', () => ({ setupMCPRoutes: vi.fn() }));

const ISSUER = 'https://issuer.example.invalid';

async function register(sessionRevalidationUrl: string | undefined) {
  const config = {
    external_launch: {
      enabled: true,
      exchange_url: `${ISSUER}/exchange`,
      session_revalidation_url: sessionRevalidationUrl,
      issuer: ISSUER,
      audience: 'runtime:test',
      dev_shared_secret: 'disposable-test-not-a-credential',
      service_credential: 'disposable-test-not-a-credential',
    },
  };
  const { settings, error } = resolveExternalLaunchSettings(config as never);
  if (error) throw new Error(error);
  const raw = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(raw);
  const db = createTenantScopedDatabaseProxy(raw);
  const app = feathersExpress(feathers());
  app.use(feathersExpress.json());
  app.configure(rest());
  app.configure(socketio());
  for (const path of ['users', 'tasks', 'repos', 'branches', 'session-mcp-servers']) {
    app.use(path, { get: vi.fn() });
  }
  app.use('sessions', { get: vi.fn(), setQueueProcessor: () => undefined });
  await registerRoutes({
    app: app as unknown as Application,
    db,
    config,
    superadminOpts: { allowSuperadmin: false },
    externalLaunchProvider: settings,
    deployment: { mode: 'single' },
    jwtSecret: 'disposable-test-not-a-credential',
    sessionsRepository: new SessionRepository(db),
    branchRepository: new BranchRepository(db),
    usersRepository: new UsersRepository(db),
    sessionMCPServersService: new SessionMCPServersService(db),
    sessionsService: app.service('sessions'),
    requireAuth: (context: unknown) => context,
    enforcePasswordChange: (context: unknown) => context,
  } as unknown as RegisterRoutesContext);
}

describe('personal API key membership check wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(setupMCPRoutes).mockClear();
  });

  it('gives REST and MCP the same check on a revalidating install', async () => {
    const setCheck = vi.spyOn(ApiKeyStrategy.prototype, 'setMembershipCheck');
    await register(`${ISSUER}/revalidate`);
    const check = setCheck.mock.calls[0][0];
    expect(check).toBeTypeOf('function');
    expect(vi.mocked(setupMCPRoutes).mock.calls[0][4]).toMatchObject({
      apiKeyMembershipCheck: check,
    });
  });

  it('adds no check without a revalidation URL', async () => {
    const setCheck = vi.spyOn(ApiKeyStrategy.prototype, 'setMembershipCheck');
    await register(undefined);
    expect(setCheck).toHaveBeenCalledWith(undefined);
    expect(vi.mocked(setupMCPRoutes).mock.calls[0][4]?.apiKeyMembershipCheck).toBeUndefined();
  });
});
