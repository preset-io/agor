import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  GatewayChannelRepository,
  generateId,
  getCurrentTenantDatabaseScope,
  RepoRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { GatewayConnector } from '@agor/core/gateway';
import { getConnector } from '@agor/core/gateway';
import type { GatewayConnectionTestResult, SlackAppInfo, TenantID } from '@agor/core/types';
import { afterEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { type RegisterHooksContext, registerHooks } from '../register-hooks.js';
import { createGatewayChannelsAppInfoService } from './gateway-channels-app-info.js';
import { createGatewayChannelsTestService } from './gateway-channels-test.js';

vi.mock('@agor/core/gateway', () => ({ getConnector: vi.fn() }));

process.env.AGOR_MASTER_SECRET ||= 'gateway-channel-tenant-scope-test-secret';

describe('gateway channel probe tenant boundary', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  dbTest(
    'opens repository reads for nested calls and closes the scope before provider I/O',
    async ({ db }) => {
      const tenantId = 'tenant-a' as TenantID;
      const owner = await new UsersRepository(db).create({
        user_id: generateId(),
        email: 'gateway-probe@example.test',
        name: 'Gateway probe scope test',
        role: 'admin',
      });
      const repo = await new RepoRepository(db).create({
        repo_id: generateId(),
        slug: `gateway-probe-${generateId()}`,
        name: 'Gateway probe scope test',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/gateway-probe.git',
        local_path: `/tmp/${generateId()}`,
        default_branch: 'main',
      });
      const branch = await new BranchRepository(db).create({
        branch_id: generateId(),
        repo_id: repo.repo_id,
        name: `gateway-probe-${generateId()}`,
        ref: 'main',
        branch_unique_id: 1,
        path: `/tmp/${generateId()}`,
        created_by: owner.user_id,
      });
      const channel = await new GatewayChannelRepository(db).create({
        id: generateId(),
        name: 'Gateway probe scope test',
        channel_type: 'slack',
        channel_key: `gateway-probe-${generateId()}`,
        enabled: false,
        target_branch_id: branch.branch_id,
        agor_user_id: owner.user_id,
        created_by: owner.user_id,
        config: { bot_token: 'xoxb-probe-token', app_token: 'xapp-probe-token' },
      });

      const guardedDb = createTenantScopedDatabaseProxy(db, {
        requireScope: true,
        label: 'gateway probe SQLite database',
      });
      const providerScopes: Array<unknown> = [];
      const testResult: GatewayConnectionTestResult = {
        ok: true,
        failures: [],
        notVerifiable: [],
      };
      const appInfo: SlackAppInfo = { appId: 'app-a', teamId: 'team-a' };
      const connector = {
        channelType: 'slack',
        testConnection: vi.fn(async () => {
          providerScopes.push(getCurrentTenantDatabaseScope());
          return testResult;
        }),
        getAppInfo: vi.fn(async () => {
          providerScopes.push(getCurrentTenantDatabaseScope());
          return appInfo;
        }),
      } as unknown as GatewayConnector;
      vi.mocked(getConnector).mockReturnValue(connector);

      const app = feathers();
      app.use('gateway-channels/test', createGatewayChannelsTestService(guardedDb));
      app.use('gateway-channels/app-info', createGatewayChannelsAppInfoService(guardedDb));
      app.use('check-auth', {
        async create() {
          // These are deliberately nested internal calls with no params. The
          // outer production identity-only hook is the only source of ambient
          // tenant identity available to both registered child services.
          expect(getCurrentTenantDatabaseScope()).toBeUndefined();
          const test = await app
            .service('gateway-channels/test')
            .create({ gatewayChannelId: channel.id });
          expect(getCurrentTenantDatabaseScope()).toBeUndefined();
          const resolvedAppInfo = await app
            .service('gateway-channels/app-info')
            .create({ gatewayChannelId: channel.id });
          expect(getCurrentTenantDatabaseScope()).toBeUndefined();
          return { test, appInfo: resolvedAppInfo };
        },
      });

      const registeredAroundHooks = new Map<string, unknown[]>();
      for (const path of ['gateway-channels/test', 'gateway-channels/app-info']) {
        const service = app.service(path) as unknown as {
          hooks: (hooks: { around?: { all?: unknown[] } }) => unknown;
        };
        const installHooks = service.hooks.bind(service);
        service.hooks = (hooks) => {
          if (hooks.around?.all) registeredAroundHooks.set(path, [...hooks.around.all]);
          return installHooks(hooks);
        };
      }

      const placeholderService = () => ({
        async find() {
          return [];
        },
        async get() {
          return {};
        },
        async create(data: unknown) {
          return data;
        },
        async update(_id: unknown, data: unknown) {
          return data;
        },
        async patch(_id: unknown, data: unknown) {
          return data;
        },
        async remove() {
          return {};
        },
      });
      for (const path of [
        'messages',
        'repos',
        'branches',
        'users',
        'sessions',
        'leaderboard',
        'schedules',
        'tasks',
      ]) {
        app.use(path, placeholderService());
      }
      (app as unknown as { publish: (publisher: unknown) => unknown }).publish = () => app;

      registerHooks({
        db: guardedDb,
        app: app as RegisterHooksContext['app'],
        config: {
          database: { dialect: 'sqlite' },
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
          execution: { unix_user_mode: 'simple' },
        } as AgorConfig,
        jwtSecret: 'gateway-probe-test-secret',
        requireAuth: async (context) => context,
        superadminOpts: { allowSuperadmin: true },
        sessionsService: {} as RegisterHooksContext['sessionsService'],
        messagesService: {} as RegisterHooksContext['messagesService'],
        boardsService: undefined,
        branchRepository: {} as RegisterHooksContext['branchRepository'],
        usersRepository: {} as RegisterHooksContext['usersRepository'],
        sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
        deployment: { mode: 'standalone' },
      });

      // The child paths themselves, not a manually reconstructed hook, must be
      // in the production identity-only registration loop. This assertion is
      // intentionally tied to the real service registration calls above.
      expect(registeredAroundHooks.get('gateway-channels/test')).toHaveLength(1);
      expect(registeredAroundHooks.get('gateway-channels/app-info')).toHaveLength(1);

      const authenticatedParams = {
        provider: 'rest',
        authenticated: true,
        user: { user_id: owner.user_id, role: 'admin' },
        tenant: { tenant_id: tenantId, source: 'auth_claim' },
      };
      const result = await app.service('check-auth').create({}, authenticatedParams);

      expect(result).toEqual({ test: testResult, appInfo });
      expect(providerScopes).toEqual([undefined, undefined]);
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
    }
  );
});
