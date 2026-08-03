import { describe, expect, it } from 'vitest';
import { OPENCODE_AUXILIARY_ADAPTER } from './auxiliary-adapter.js';

const context = { dataHome: '/home/alice/.local/share/agor/opencode/opaque' };

describe('OpenCode auxiliary adapter', () => {
  it('rejects obsolete branch input for the user-scoped selection catalog', async () => {
    await expect(
      OPENCODE_AUXILIARY_ADAPTER.execute({
        context,
        request: { operation: 'read-model-catalog', directory: '/worktrees/private' },
        dryRun: true,
      })
    ).rejects.toThrow();
  });

  it('accepts authorized branch-scoped configuration discovery behind the generic envelope', async () => {
    await expect(
      OPENCODE_AUXILIARY_ADAPTER.execute({
        context,
        request: { operation: 'discover', directory: '/worktrees/authorized' },
        dryRun: true,
      })
    ).resolves.toEqual({
      success: true,
      data: { dryRun: true, operation: 'discover' },
    });
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
