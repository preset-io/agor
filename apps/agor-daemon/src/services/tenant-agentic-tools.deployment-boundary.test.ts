import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import { TenantAgenticToolSettingsService } from './tenant-agentic-tools.js';

describe('tenant agentic tool deployment boundary', () => {
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
