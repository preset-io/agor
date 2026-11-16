import { TenantAgenticToolSettingsRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TenantAgenticToolSettingsService } from './tenant-agentic-tools.js';

afterEach(() => vi.restoreAllMocks());

// Multi-tenant → shared daemon → public-only egress enforced.
const enforced = { multi_tenancy: { mode: 'required_from_auth' } } as never;
// Default (simple + static + standalone) → trusted-local → permissive.
const trustedLocal = {} as never;

describe('workspace agentic-tool base URL validation', () => {
  it('rejects a private base URL and does not persist it on an enforced deployment', async () => {
    const patchSpy = vi
      .spyOn(TenantAgenticToolSettingsRepository.prototype, 'patch')
      .mockResolvedValue(undefined as never);
    const service = new TenantAgenticToolSettingsService({} as TenantScopeAwareDatabase, enforced);

    await expect(
      service.patch('codex', { connection: { OPENAI_BASE_URL: 'https://10.0.0.5' } })
    ).rejects.toBeInstanceOf(BadRequest);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('persists a public HTTPS base URL on an enforced deployment', async () => {
    vi.spyOn(TenantAgenticToolSettingsRepository.prototype, 'patch').mockResolvedValue(
      undefined as never
    );
    vi.spyOn(TenantAgenticToolSettingsRepository.prototype, 'find').mockResolvedValue({});
    const service = new TenantAgenticToolSettingsService({} as TenantScopeAwareDatabase, enforced);

    await expect(
      service.patch('codex', { connection: { OPENAI_BASE_URL: 'https://93.184.216.34/v1' } })
    ).resolves.toBeDefined();
  });

  it('allows a local base URL on a trusted-local install', async () => {
    vi.spyOn(TenantAgenticToolSettingsRepository.prototype, 'patch').mockResolvedValue(
      undefined as never
    );
    vi.spyOn(TenantAgenticToolSettingsRepository.prototype, 'find').mockResolvedValue({});
    const service = new TenantAgenticToolSettingsService(
      {} as TenantScopeAwareDatabase,
      trustedLocal
    );

    await expect(
      service.patch('codex', { connection: { OPENAI_BASE_URL: 'http://localhost:1234' } })
    ).resolves.toBeDefined();
  });
});
