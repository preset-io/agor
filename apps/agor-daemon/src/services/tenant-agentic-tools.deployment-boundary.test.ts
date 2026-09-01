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
      revision: 0,
      deployment_available: false,
      enabled: false,
    });
    await expect(service.get('claude-code')).resolves.toMatchObject({
      tool: 'claude-code',
      revision: 0,
      deployment_available: true,
      enabled: true,
    });
    await expect(service.get('workload')).resolves.toMatchObject({
      tool: 'workload',
      revision: 0,
      deployment_available: false,
      enabled: false,
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

  it('reports the built-in workload disabled until the tenant explicitly enables it', async () => {
    vi.spyOn(TenantAgenticToolSettingsRepository.prototype, 'find').mockResolvedValue({});
    const service = new TenantAgenticToolSettingsService({} as TenantScopeAwareDatabase);

    await expect(service.get('workload')).resolves.toMatchObject({
      tool: 'workload',
      deployment_available: true,
      enabled: false,
    });
  });

  it.each([
    { inline_configuration_allowed: false },
    { resolution_policy: 'user_required' as const },
    { connection: {} },
  ])('rejects provider and preset configuration for the built-in workload', async (patch) => {
    const service = new TenantAgenticToolSettingsService({} as TenantScopeAwareDatabase);

    await expect(service.patch('workload', patch)).rejects.toThrow(
      'workload only supports workspace enablement'
    );
  });

  it('publishes the durable revision without exposing the rotated credential', async () => {
    const syntheticSecret = 'synthetic-workspace-secret-must-not-leak';
    vi.spyOn(TenantAgenticToolSettingsRepository.prototype, 'find').mockResolvedValue({
      revision: 7,
      connection: { ANTHROPIC_AUTH_TOKEN: syntheticSecret },
    });
    const service = new TenantAgenticToolSettingsService({} as TenantScopeAwareDatabase);

    const settings = await service.get('claude-code');

    expect(settings).toMatchObject({
      tool: 'claude-code',
      revision: 7,
      connection: { ANTHROPIC_AUTH_TOKEN: { configured: true } },
    });
    expect(JSON.stringify(settings)).not.toContain(syntheticSecret);
  });
});
