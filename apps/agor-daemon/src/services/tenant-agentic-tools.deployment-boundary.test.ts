import { TenantAgenticToolSettingsRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { TENANT_AGENTIC_TOOL_NAMES } from '@agor/core/types';
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
  it('uses one batch, retaining tool order, defaults, deployment policy and secret redaction', async () => {
    const find = vi.spyOn(TenantAgenticToolSettingsRepository.prototype, 'find');
    const all = vi
      .spyOn(TenantAgenticToolSettingsRepository.prototype, 'findAll')
      .mockResolvedValue(
        new Map(
          TENANT_AGENTIC_TOOL_NAMES.map((tool) => [
            tool,
            tool === 'codex'
              ? { revision: 3, connection: { OPENAI_API_KEY: 'synthetic-secret' } }
              : {},
          ])
        )
      );
    const service = new TenantAgenticToolSettingsService(
      {} as TenantScopeAwareDatabase,
      (tool) => tool !== 'codex'
    );
    const settings = await service.find();
    expect(settings.map((setting) => setting.tool)).toEqual([...TENANT_AGENTIC_TOOL_NAMES]);
    expect(settings.find((setting) => setting.tool === 'codex')).toMatchObject({
      revision: 3,
      enabled: false,
      deployment_available: false,
      connection: { OPENAI_API_KEY: { configured: true } },
    });
    expect(settings.find((setting) => setting.tool === 'claude-code')).toMatchObject({
      revision: 0,
      enabled: true,
    });
    expect(JSON.stringify(settings)).not.toContain('synthetic-secret');
    expect(all).toHaveBeenCalledTimes(1);
    expect(find).not.toHaveBeenCalled();
  });
});
