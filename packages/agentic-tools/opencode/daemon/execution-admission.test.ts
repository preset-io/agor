import { describe, expect, it, vi } from 'vitest';
import { admitAgenticToolExecutor } from '../../src/daemon';

describe('OpenCode executor admission', () => {
  it('rejects hosted native auth before token creation or executor spawn', async () => {
    const generateToken = vi.fn();
    const spawnExecutor = vi.fn();

    await expect(
      admitAgenticToolExecutor(
        {
          tool: 'opencode',
          tenantId: 'tenant-a',
          config: {
            multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
          } as never,
        },
        async () => {
          await generateToken();
          spawnExecutor();
        }
      )
    ).rejects.toThrow(/unavailable in hosted multi-tenant mode/i);

    expect(generateToken).not.toHaveBeenCalled();
    expect(spawnExecutor).not.toHaveBeenCalled();
  });
});
