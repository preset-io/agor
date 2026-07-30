import { describe, expect, it, vi } from 'vitest';
import { admitAgenticToolExecutor, getAgenticToolExecutorPayload } from './daemon';

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

  it('contributes an opaque adapter context instead of adding host payload fields', () => {
    const payload = getAgenticToolExecutorPayload('opencode', {
      tenantId: 'tenant-a',
      session: {
        created_by: 'user-1',
        unix_username: 'alice',
      } as never,
      homeDir: '/home/alice',
    });

    const context = payload.agenticToolContext as { dataHome: string };
    expect(context.dataHome.startsWith('/home/alice/.local/share/agor/opencode/')).toBe(true);
    expect(payload).not.toHaveProperty('dataHome');
  });
});
