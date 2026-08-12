import { TenantAgenticToolSettingsRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TenantAgenticToolSettingsService } from './tenant-agentic-tools.js';

afterEach(() => vi.restoreAllMocks());

describe('tenant agentic tool deployment boundary', () => {
  it('reports deployment availability separately from workspace enablement', async () => {
    vi.spyOn(TenantAgenticToolSettingsRepository.prototype, 'find').mockResolvedValue({});
    const service = new TenantAgenticToolSettingsService(
      {} as TenantScopeAwareDatabase,
      (tool) => tool === 'claude-code'
    );

    await expect(service.get('codex')).resolves.toMatchObject({
      tool: 'codex',
      deployment_available: false,
      enabled: false,
    });
    await expect(service.get('claude-code')).resolves.toMatchObject({
      tool: 'claude-code',
      deployment_available: true,
      enabled: true,
    });
  });

  it('rejects enabling a package the deployment operator did not configure', async () => {
    const service = new TenantAgenticToolSettingsService(
      {} as TenantScopeAwareDatabase,
      (tool) => tool === 'claude-code'
    );

    await expect(service.patch('codex', { enabled: true })).rejects.toThrow(
      /unavailable under this deployment's agentic-tool policy/
    );
  });
});
