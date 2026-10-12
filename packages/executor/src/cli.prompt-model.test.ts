/**
 * `params.model` on a prompt payload is informational for external launchers.
 * The executor keeps reading the model from the session, so the CLI must not
 * forward the payload copy into AgorExecutor.
 */

import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executorOptions: vi.fn(),
  executorStart: vi.fn(async () => undefined),
}));

vi.mock('@agor/core/templates/handlebars-helpers', () => ({
  registerHandlebarsHelpers: vi.fn(),
}));
vi.mock('./handlers/sdk/tool-registry.js', () => ({
  initializeToolRegistry: vi.fn(async () => undefined),
  ToolRegistry: { has: () => true, getAll: () => ['claude-code'] },
}));
vi.mock('./index.js', () => ({
  AgorExecutor: class {
    constructor(options: unknown) {
      mocks.executorOptions(options);
    }
    start = mocks.executorStart;
  },
}));

const savedArgv = process.argv;
const savedStdin = Object.getOwnPropertyDescriptor(process, 'stdin');

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = savedArgv;
  if (savedStdin) Object.defineProperty(process, 'stdin', savedStdin);
});

describe('prompt payload model', () => {
  it('does not hand the informational model to the executor', async () => {
    process.argv = ['node', 'cli.js', '--stdin'];
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: Readable.from([
        Buffer.from(
          JSON.stringify({
            command: 'prompt',
            sessionToken: 'jwt',
            params: {
              sessionId: '550e8400-e29b-41d4-a716-446655440000',
              taskId: '550e8400-e29b-41d4-a716-446655440001',
              prompt: 'Hello',
              tool: 'claude-code',
              model: 'payload-model',
              cwd: '/tmp',
            },
          })
        ),
      ]),
    });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    vi.resetModules();
    await import('./cli.js');
    await vi.waitFor(() => expect(mocks.executorStart).toHaveBeenCalledOnce());

    const options = mocks.executorOptions.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.tool).toBe('claude-code');
    expect(JSON.stringify(options)).not.toContain('payload-model');
  });
});
