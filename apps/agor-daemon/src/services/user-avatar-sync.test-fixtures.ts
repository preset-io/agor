import { type AgorConfig, resolveDeploymentConfig } from '@agor/core/config';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  GatewayChannelRepository,
  generateId,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { Params, TenantID } from '@agor/core/types';
import { type RegisterHooksContext, registerHooks } from '../register-hooks.js';
import { USERS_SERVICE_TRANSPORT_METHODS, UsersService } from './users.js';

export async function seedAvatarTenant(
  db: Parameters<typeof createTenantScopedDatabaseProxy>[0],
  tenantId: TenantID
) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      user_id: generateId(),
      email: 'avatar@example.test',
      name: 'Avatar test',
      role: 'admin',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `avatar-${generateId()}`,
      name: 'Avatar test',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/avatar.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `avatar-${generateId()}`,
      ref: 'main',
      branch_unique_id: 1,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const channel = await new GatewayChannelRepository(scoped).create({
      id: generateId(),
      name: 'Avatar test',
      channel_type: 'slack',
      channel_key: `avatar-${generateId()}`,
      enabled: false,
      target_branch_id: branch.branch_id,
      agor_user_id: user.user_id,
      created_by: user.user_id,
      config: { bot_token: 'synthetic-avatar-bot-token' },
    });
    const params = {
      provider: 'rest',
      authenticated: true,
      user,
      tenant: { tenant_id: tenantId, source: 'auth_claim' },
    } as Params;
    return { user, channel, params, tenantId };
  });
}

/** Real users service + production hook registration over an armed scope guard. */
export function avatarTestApp(
  rawDb: Parameters<typeof createTenantScopedDatabaseProxy>[0],
  config: AgorConfig,
  ha = false
) {
  const db = createTenantScopedDatabaseProxy(rawDb, { requireScope: true, label: 'avatar test' });
  const app = feathers();
  app.set('config', config);
  app.use('users', new UsersService(db, app, config), {
    methods: [...USERS_SERVICE_TRANSPORT_METHODS],
  });
  const placeholder = () => ({
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
    'sessions',
    'leaderboard',
    'schedules',
    'tasks',
  ]) {
    app.use(path, placeholder());
  }
  (app as unknown as { publish: (publisher: unknown) => unknown }).publish = () => app;
  registerHooks({
    db,
    app: app as RegisterHooksContext['app'],
    config,
    jwtSecret: 'avatar-fixture-secret',
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository: new BranchRepository(db),
    usersRepository: new UsersRepository(db),
    sessionsRepository: new SessionRepository(db),
    deployment: ha
      ? resolveDeploymentConfig(
          {
            database: { dialect: 'postgresql' },
            deployment: {
              mode: 'ha',
              redis: { url: 'redis://example.invalid:6379', key_prefix: 'avatar-test' },
              ha: {
                support_profile: 'constrained-active-active',
                execution_topology: 'shared-local',
                shared_filesystem: true,
                ingress_affinity: true,
              },
            },
            execution: {
              allow_web_terminal: false,
              managed_envs_execution_mode: 'webhook-only',
              executor_storage: {
                user_home: 'shared',
                user_home_locking: 'cross-replica-flock',
                branch_workspace: 'shared',
                base_repository: 'shared',
              },
            },
          },
          {
            AGOR_JWT_SECRET: 'j'.repeat(32),
            AGOR_MASTER_SECRET: 'm'.repeat(32),
            AGOR_ADMIN_PASSWORD: 'fixture-admin-password',
          }
        )
      : { mode: 'standalone' },
  });
  return { db, app, service: app.service('users') as unknown as UsersService };
}
