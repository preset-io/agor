/** Field scope of user reads: self and admins see the profile, other callers see the directory entry. */

import type { AuthenticatedParams, User, UserID, UserRole } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from './users';

const PRIVATE_PROFILE_FIELDS = [
  'env_vars',
  'agentic_tools',
  'agentic_auth_methods',
  'agentic_credential_sources',
  'primary_agentic_tool',
  'default_agentic_config',
  'default_mcp_server_ids',
  'avatar_source_id',
  'must_change_password',
  'onboarding_completed',
  'role',
  'unix_username',
] as const;

function caller(user: Pick<User, 'user_id' | 'email'>, role: UserRole): AuthenticatedParams {
  return { provider: 'rest', user: { user_id: user.user_id, email: user.email, role } };
}

async function seedTarget(service: UsersService): Promise<User> {
  const target = await service.create({
    email: 'target@example.com',
    password: 'test-password-1234',
    name: 'Target',
    emoji: '🦊',
    avatar_url: 'https://example.com/target.png',
    avatar_source: 'slack',
    avatar_source_id: 'U0SLACKID',
    must_change_password: true,
    role: ROLES.ADMIN,
    unix_username: 'tgtkey',
  });
  await service.patch(target.user_id, {
    env_vars: { HUBSPOT_ACCESS_TOKEN: 'hubspot-canary' },
    agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: 'sk-ant-canary' } },
    agentic_auth_methods: { 'claude-code': 'api_key' },
    primary_agentic_tool: 'codex',
    default_agentic_config: { codex: { modelConfig: { model: 'gpt-5' } } },
    default_mcp_server_ids: ['mcp-1'],
    preferences: { use_slack_avatar: false, mainBoardId: 'board-private' },
  });
  return service.get(target.user_id);
}

describe('UsersService profile read scope', () => {
  dbTest("limits a member's read of another user to the directory entry", async ({ db }) => {
    const service = new UsersService(db);
    const target = await seedTarget(service);
    const member = await service.create({
      email: 'member@example.com',
      password: 'test-password-1234',
    });

    const viaGet = await service.get(target.user_id, caller(member, ROLES.MEMBER));
    const viaFind = (await service.find(caller(member, ROLES.MEMBER))).data.find(
      (row) => row.user_id === target.user_id
    );

    for (const row of [viaGet, viaFind]) {
      for (const field of PRIVATE_PROFILE_FIELDS) expect(row).not.toHaveProperty(field);
      expect(row).toMatchObject({
        user_id: target.user_id,
        email: 'target@example.com',
        name: 'Target',
        emoji: '🦊',
        avatar_url: 'https://example.com/target.png',
        avatar_source: 'slack',
        preferences: { use_slack_avatar: false },
      });
      expect(row?.preferences).not.toHaveProperty('mainBoardId');
    }
  });

  dbTest('keeps the full profile for self and admin readers', async ({ db }) => {
    const service = new UsersService(db);
    const target = await seedTarget(service);
    const admin = await service.create({
      email: 'admin@example.com',
      password: 'test-password-1234',
      role: ROLES.ADMIN,
    });

    for (const params of [
      caller(target, ROLES.MEMBER),
      caller(admin, ROLES.ADMIN),
      caller(admin, ROLES.SUPERADMIN),
    ]) {
      const row = await service.get(target.user_id, params);
      expect(row.env_vars).toEqual({
        HUBSPOT_ACCESS_TOKEN: { set: true, scope: 'global', resource_id: null },
      });
      expect(row).toMatchObject({
        role: ROLES.ADMIN,
        unix_username: 'tgtkey',
        avatar_source_id: 'U0SLACKID',
        must_change_password: true,
        primary_agentic_tool: 'codex',
        default_mcp_server_ids: ['mcp-1'],
        preferences: { use_slack_avatar: false, mainBoardId: 'board-private' },
      });
    }
  });

  dbTest('projects a viewer read of another user the same way', async ({ db }) => {
    const service = new UsersService(db);
    const target = await seedTarget(service);
    const viewer = await service.create({
      email: 'viewer@example.com',
      password: 'test-password-1234',
      role: ROLES.VIEWER,
    });

    const row = await service.get(target.user_id as UserID, caller(viewer, ROLES.VIEWER));
    expect(row).not.toHaveProperty('env_vars');
    expect(row.name).toBe('Target');
  });

  dbTest('does not let a member search by hidden fields', async ({ db }) => {
    const service = new UsersService(db);
    const target = await seedTarget(service);
    const member = await service.create({
      email: 'member@example.com',
      password: 'test-password-1234',
    });
    const admin = await service.create({
      email: 'admin@example.com',
      password: 'test-password-1234',
      role: ROLES.ADMIN,
    });
    const search = (params: AuthenticatedParams, term: string) =>
      service.find({ ...params, query: { search: term } });

    expect((await search(caller(member, ROLES.MEMBER), 'tgtkey')).total).toBe(0);
    expect((await search(caller(member, ROLES.MEMBER), 'target@')).data[0]?.user_id).toBe(
      target.user_id
    );
    expect((await search(caller(admin, ROLES.ADMIN), 'tgtkey')).data[0]?.user_id).toBe(
      target.user_id
    );
  });
});
