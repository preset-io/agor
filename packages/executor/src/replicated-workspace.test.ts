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
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Original instructions' },
      includePartialMessages: true,
      tools: ['Bash'],
      settingSources: ['project'],
      mcpServers: { unsafe: {} },
    };
    configureReplicatedClaude(sdk as never, options, descriptor, request);
    expect(options.includePartialMessages).toBe(true);
    expect((options.systemPrompt as { append: string }).append).toContain('Original instructions');
    expect((options.systemPrompt as { append: string }).append).toContain('briefly tell the user');
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
  it('preserves explicit approval modes and refuses tools without an approval channel', async () => {
    const sdk = { createSdkMcpServer: (value: unknown) => value, tool: () => ({}) };
    const approve = vi.fn().mockResolvedValue({ behavior: 'deny', message: 'user denied' });
    const options: Record<string, unknown> = { canUseTool: approve, permissionMode: 'default' };
    configureReplicatedClaude(sdk as never, options, descriptor);
    expect(options.allowedTools).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    const gate = options.canUseTool as (
      name: string,
      input: unknown,
      context: unknown
    ) => Promise<unknown>;
    expect(await gate('mcp__agor_workspace__execute', { command: 'test' }, {})).toMatchObject({
      behavior: 'deny',
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(await gate('Bash', {}, {})).toMatchObject({ behavior: 'deny' });
    expect(approve).toHaveBeenCalledTimes(1);
    const bypass: Record<string, unknown> = { permissionMode: 'bypassPermissions' };
    configureReplicatedClaude(sdk as never, bypass, descriptor);
    expect(bypass.allowedTools).toEqual(['mcp__agor_workspace__execute']);
  });
});
