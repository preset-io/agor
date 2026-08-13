import { describe, expect, it } from 'vitest';
import { diagnoseWebTerminalRuntime } from './optional-capabilities.js';

describe('diagnoseWebTerminalRuntime', () => {
  it('reports a scriptless PTY implementation as ready', async () => {
    await expect(
      diagnoseWebTerminalRuntime(
        async () => ({ spawn: () => undefined }) as never,
        async () => undefined
      )
    ).resolves.toMatchObject({ status: 'ready', optional: true });
  });

  it('keeps a missing PTY implementation optional and actionable', async () => {
    const result = await diagnoseWebTerminalRuntime(async () => {
      throw new Error('unsupported platform');
    });
    expect(result).toMatchObject({ status: 'unavailable', optional: true });
    expect(result.detail).toContain('unsupported platform');
    expect(result.docs).toContain('#optional-web-terminal-runtime');
  });
});
