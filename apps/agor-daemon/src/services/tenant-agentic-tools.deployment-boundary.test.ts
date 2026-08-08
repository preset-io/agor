import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import { TenantAgenticToolSettingsService } from './tenant-agentic-tools.js';

describe('tenant agentic tool deployment boundary', () => {
  it('rejects enabling a package the deployment operator did not configure', async () => {
    const service = new TenantAgenticToolSettingsService(
      {} as TenantScopeAwareDatabase,
      new Set(['claude-code'])
    );

    await expect(service.patch('codex', { enabled: true })).rejects.toThrow(
      /operator must add it to config\.yaml agentic_tools\.installed and run agor install/
    );
  });
});
