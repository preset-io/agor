import { beforeAll, describe, expect } from 'vitest';
import { dbTest } from '../test-helpers';
import { TenantAgenticToolSettingsRepository } from './tenant-agentic-tools';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'tenant-agentic-tools-test-secret';
});

describe('TenantAgenticToolSettingsRepository', () => {
  dbTest('infers enabled=true without materializing a row', async ({ db }) => {
    const repository = new TenantAgenticToolSettingsRepository(db);
    await expect(repository.find('codex')).resolves.toEqual({});
    await expect(repository.isEnabled('codex')).resolves.toBe(true);
  });

  dbTest('stores enabled and provider connection atomically', async ({ db }) => {
    const repository = new TenantAgenticToolSettingsRepository(db);
    await repository.patch('codex', {
      enabled: false,
      connection: {
        OPENAI_API_KEY: 'workspace-key',
        OPENAI_BASE_URL: 'https://example.invalid/v1',
      },
    });

    await expect(repository.find('codex')).resolves.toEqual({
      enabled: false,
      connection: {
        OPENAI_API_KEY: 'workspace-key',
        OPENAI_BASE_URL: 'https://example.invalid/v1',
      },
    });
  });

  dbTest('explicit null clears a secret without changing other fields', async ({ db }) => {
    const repository = new TenantAgenticToolSettingsRepository(db);
    await repository.patch('claude-code', {
      connection: {
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_BASE_URL: 'https://example.invalid',
      },
    });
    await repository.patch('claude-code', {
      connection: { ANTHROPIC_API_KEY: null },
    });

    await expect(repository.find('claude-code')).resolves.toEqual({
      connection: { ANTHROPIC_BASE_URL: 'https://example.invalid' },
    });
  });

  dbTest(
    'stores non-default resolution policy without deleting dormant credentials',
    async ({ db }) => {
      const repository = new TenantAgenticToolSettingsRepository(db);
      await repository.patch('codex', {
        connection: { OPENAI_API_KEY: 'workspace-key' },
        resolution_policy: 'user_required',
      });
      await expect(repository.find('codex')).resolves.toEqual({
        resolution_policy: 'user_required',
        connection: { OPENAI_API_KEY: 'workspace-key' },
      });

      await repository.patch('codex', { resolution_policy: 'tenant_required' });
      await expect(repository.find('codex')).resolves.toEqual({
        resolution_policy: 'tenant_required',
        connection: { OPENAI_API_KEY: 'workspace-key' },
      });
    }
  );
});
