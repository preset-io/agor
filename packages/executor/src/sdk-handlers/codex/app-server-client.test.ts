import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, forkCodexThreadViaAppServer } from './app-server-client.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

describe('Codex fork sidecar plugin policy', () => {
  beforeEach(() => spawn.mockReset());

  it.each([undefined, false, true])(
    'honors opt-in %s without changing fork identity or environment',
    async (includePlugins) => {
      const requests: Array<{ id?: number; method: string; params: unknown }> = [];
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new PassThrough(),
        stdin: new Writable({
          write(chunk, _encoding, callback) {
            const request = JSON.parse(String(chunk));
            requests.push(request);
            if (request.id !== undefined) {
              stdout.write(
                `${JSON.stringify({
                  id: request.id,
                  result:
                    request.method === 'thread/fork' ? { thread: { id: 'forked-thread' } } : {},
                })}\n`
              );
            }
            callback();
          },
        }),
        exitCode: null,
        signalCode: null as string | null,
        kill: vi.fn(() => {
          child.signalCode = 'SIGTERM';
          stdout.end();
          child.emit('exit', null, 'SIGTERM');
          return true;
        }),
      });
      spawn.mockImplementation(() => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      });

      await expect(
        forkCodexThreadViaAppServer('parent-thread', {
          includePlugins,
          env: { CODEX_HOME: '/fixture/tenant-a/branch-home/codex' },
        })
      ).resolves.toBe('forked-thread');
      expect(spawn).toHaveBeenCalledWith(
        'codex',
        includePlugins ? ['app-server'] : ['app-server', '--config', 'features.plugins=false'],
        expect.objectContaining({
          env: expect.objectContaining({ CODEX_HOME: '/fixture/tenant-a/branch-home/codex' }),
        })
      );
      expect(requests.at(-1)).toMatchObject({
        method: 'thread/fork',
        params: { threadId: 'parent-thread' },
      });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    }
  );
});

describe('Codex thread retirement', () => {
  it.each(['deleted', 'absent', 'foreign-home'] as const)('handles %s', async (scenario) => {
    spawn.mockReset();
    const home = '/fixture/branch-homes/branch/codex';
    const threadId = '00000000-0000-4000-8000-000000000001';
    const requests: { method: string; params: unknown }[] = [];
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null as string | null,
      kill: vi.fn(() => {
        child.signalCode = 'SIGTERM';
        stdout.end();
        child.emit('exit', null, 'SIGTERM');
        return true;
      }),
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          const request = JSON.parse(String(chunk));
          requests.push(request);
          const response =
            request.method === 'initialize'
              ? {
                  result: {
                    codexHome: scenario === 'foreign-home' ? '/different' : home,
                    userAgent: 'agor-thread-retirement/0.169.0 (test)',
                  },
                }
              : scenario === 'absent'
                ? { error: { code: -32600, message: `no rollout found for thread id ${threadId}` } }
                : { result: {} };
          if (request.id !== undefined)
            stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
          callback();
        },
      }),
    });
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const client = new CodexAppServerClient({
      retirementHome: home,
      env: { OPENAI_API_KEY: 'secret' },
    });
    try {
      if (scenario === 'foreign-home') {
        await expect(client.retireThread(threadId)).rejects.toThrow('retirement runtime mismatch');
        expect(requests.map(({ method }) => method)).toEqual(['initialize']);
      } else {
        await expect(client.retireThread(threadId)).resolves.toBeUndefined();
        expect(requests.at(-1)).toMatchObject({ method: 'thread/delete', params: { threadId } });
      }
      expect(spawn.mock.calls[0]?.[2].env).not.toHaveProperty('OPENAI_API_KEY');
    } finally {
      await client.close();
    }
  });
});
