import { describe, expect, it, vi } from 'vitest';
import {
  configureReplicatedClaude,
  currentReplicatedWorkspace,
  finalizeReplicatedSession,
  markUnverifiedSdkTeardown,
  withReplicatedWorkspace,
} from './replicated-workspace';

const descriptor = {
  endpoint: 'http://worker:8787',
  capability: 'x'.repeat(64),
  cwd: '/workspace',
};
describe('native replicated workspace boundary', () => {
  it('refuses unsupported providers and keeps contexts isolated', async () => {
    await expect(withReplicatedWorkspace(descriptor, 'codex', async () => {})).rejects.toThrow();
    await withReplicatedWorkspace(descriptor, 'claude-code', async () =>
      expect(currentReplicatedWorkspace()).toEqual(descriptor)
    );
    expect(currentReplicatedWorkspace()).toBeUndefined();
  });
  it('removes native write paths and routes the actual model tool through the controller', async () => {
    let handler: (args: { command: string; timeout_ms: number }) => Promise<unknown> = async () =>
      undefined;
    const sdk = {
      createSdkMcpServer: vi.fn((x) => x),
      tool: vi.fn((_name, _description, _schema, callback) => {
        handler = callback;
        return {};
      }),
    };
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ exitCode: 0, outcome: { status: 'committed', revision: 2 } }))
      );
    const options: Record<string, unknown> = {
      tools: ['Bash'],
      settingSources: ['project'],
      mcpServers: { unsafe: {} },
    };
    configureReplicatedClaude(sdk as never, options, descriptor, request);
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(Object.keys(options.mcpServers as object)).toEqual(['agor_workspace']);
    const result = await handler({ command: 'echo test > a', timeout_ms: 1000 });
    expect(result).toMatchObject({ isError: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('http://worker:8787/execute');
    request.mockRejectedValueOnce(new Error('lost acknowledgement'));
    await expect(handler({ command: 'echo twice', timeout_ms: 1000 })).rejects.toThrow(
      'lost acknowledgement'
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not report completion after unverified SDK teardown', async () => {
    await withReplicatedWorkspace({ ...descriptor }, 'claude-code', async () => {
      markUnverifiedSdkTeardown();
      await expect(finalizeReplicatedSession()).rejects.toThrow('teardown unverified');
    });
  });
});
