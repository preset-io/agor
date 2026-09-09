import {
  runWithTenantContext,
  TenantAgenticToolSettingsRepository,
  UsersRepository,
} from '@agor/core/db';
import type { UserID } from '@agor/core/types';
import { afterEach, beforeAll, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { createCheckAuthService } from './check-auth';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'check-auth-sqlite-synthetic-master-secret';
});

afterEach(() => vi.restoreAllMocks());

describe('check-auth managed SQLite credential resolution', () => {
  dbTest('uses the same stored Claude bearer connection as session execution', async ({ db }) => {
    const users = new UsersRepository(db);
    const user = await users.create({ email: 'claude-bearer@example.test' });
    const syntheticToken = 'synthetic-claude-bearer-token';
    await users.setToolConfigField(
      user.user_id,
      'claude-code',
      'ANTHROPIC_AUTH_TOKEN',
      syntheticToken
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    const service = createCheckAuthService(db, {} as never);
    const result = await runWithTenantContext('tenant-sqlite-test', () =>
      service.create({ tool: 'claude-code' }, {
        user: { user_id: user.user_id as UserID },
      } as never)
    );

    expect(result).toMatchObject({ status: 'authenticated', method: 'api-key' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${syntheticToken}` }),
      })
    );
    expect(JSON.stringify(result)).not.toContain(syntheticToken);
  });

  dbTest('uses a workspace Claude bearer connection when policy requires it', async ({ db }) => {
    const users = new UsersRepository(db);
    const user = await users.create({ email: 'claude-workspace-bearer@example.test' });
    const syntheticToken = 'synthetic-workspace-claude-bearer-token';
    await new TenantAgenticToolSettingsRepository(db).patch('claude-code', {
      resolution_policy: 'tenant_required',
      connection: { ANTHROPIC_AUTH_TOKEN: syntheticToken },
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    const service = createCheckAuthService(db, {} as never);
    const result = await runWithTenantContext('tenant-sqlite-test', () =>
      service.create({ tool: 'claude-code' }, {
        user: { user_id: user.user_id as UserID },
      } as never)
    );

    expect(result).toMatchObject({ status: 'authenticated', method: 'api-key' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${syntheticToken}` }),
      })
    );
    expect(JSON.stringify(result)).not.toContain(syntheticToken);
  });
});
