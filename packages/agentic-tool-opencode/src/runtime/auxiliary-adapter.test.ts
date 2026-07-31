import { describe, expect, it } from 'vitest';
import { OPENCODE_AUXILIARY_ADAPTER } from './auxiliary-adapter.js';

const context = { dataHome: '/home/alice/.local/share/agor/opencode/opaque' };

describe('OpenCode auxiliary adapter', () => {
  it('owns request validation behind the generic executor envelope', async () => {
    await expect(
      OPENCODE_AUXILIARY_ADAPTER.execute({
        context,
        request: { operation: 'discover-models', directory: '' },
        dryRun: true,
      })
    ).rejects.toThrow();
  });

  it('runs bounded non-Task operations from opaque context', async () => {
    await expect(
      OPENCODE_AUXILIARY_ADAPTER.execute({
        context,
        request: { operation: 'discover' },
        dryRun: true,
      })
    ).resolves.toEqual({
      success: true,
      data: { dryRun: true, operation: 'discover' },
    });
  });

  it('routes interactive OAuth without reading a control frame during dry-run', async () => {
    await expect(
      OPENCODE_AUXILIARY_ADAPTER.executeInteractive(
        {
          context,
          request: {
            operation: 'connect-oauth',
            providerId: 'openai',
            method: 0,
          },
          dryRun: true,
        },
        {
          emit() {},
          async read() {
            throw new Error('dry-run must not read OAuth input');
          },
        }
      )
    ).resolves.toEqual({
      success: true,
      data: { dryRun: true, operation: 'connect-oauth' },
    });
  });
});
