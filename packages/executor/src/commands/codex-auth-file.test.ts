import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleCodexAuthFile } from './codex-auth-file.js';

const originalCodexHome = process.env.CODEX_HOME;
afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe('codex.auth-file executor boundary', () => {
  it('atomically writes 0600, reads, and idempotently deletes in its own runtime home', async () => {
    process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), 'agor-codex-auth-'));
    const content = '{"tokens":{"refresh_token":"secret"}}\n';
    const base = { command: 'codex.auth-file' as const };

    await handleCodexAuthFile({ ...base, params: { operation: 'write', content: 'old' } }, {});
    await handleCodexAuthFile({ ...base, params: { operation: 'write', content } }, {});
    expect(await readFile(join(process.env.CODEX_HOME, 'auth.json'), 'utf8')).toBe(content);
    expect((await stat(join(process.env.CODEX_HOME, 'auth.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(process.env.CODEX_HOME)).toEqual(['auth.json']);

    const inspection = await handleCodexAuthFile({ ...base, params: { operation: 'inspect' } }, {});
    expect(inspection).toEqual({
      success: true,
      data: { status: 'found', authMode: 'chatgpt' },
    });

    await handleCodexAuthFile({ ...base, params: { operation: 'delete' } }, {});
    await handleCodexAuthFile({ ...base, params: { operation: 'delete' } }, {});
    expect(await handleCodexAuthFile({ ...base, params: { operation: 'inspect' } }, {})).toEqual({
      success: true,
      data: { status: 'not-found' },
    });
  });

  it('reports unreadable without including credential contents', async () => {
    process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), 'agor-codex-auth-'));
    await mkdir(join(process.env.CODEX_HOME, 'auth.json'));
    const result = await handleCodexAuthFile(
      { command: 'codex.auth-file', params: { operation: 'inspect' } },
      {}
    );
    expect(result).toEqual({
      success: false,
      error: {
        code: 'AUTH_FILE_UNREADABLE',
        message: 'Codex auth file could not be read',
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('does not follow a symlinked CODEX_HOME during mutation or inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-codex-home-boundary-'));
    const callerHome = join(root, 'caller');
    const otherCodexHome = join(root, 'other', '.codex');
    await mkdir(callerHome, { recursive: true });
    await mkdir(otherCodexHome, { recursive: true });
    await writeFile(
      join(otherCodexHome, 'auth.json'),
      '{"auth_mode":"chatgpt","tokens":{"refresh_token":"other-user-secret"}}'
    );
    await symlink(otherCodexHome, join(callerHome, '.codex'));
    process.env.CODEX_HOME = join(callerHome, '.codex');

    await expect(
      handleCodexAuthFile(
        {
          command: 'codex.auth-file',
          params: { operation: 'write', content: '{"tokens":{"refresh_token":"secret"}}' },
        },
        {}
      )
    ).rejects.toThrow();
    await expect(
      handleCodexAuthFile({ command: 'codex.auth-file', params: { operation: 'inspect' } }, {})
    ).resolves.toMatchObject({ success: false, error: { code: 'AUTH_FILE_UNREADABLE' } });
    await expect(readFile(join(otherCodexHome, 'auth.json'), 'utf8')).resolves.toContain(
      'other-user-secret'
    );
  });

  it('fences delayed writes and logout with a durable per-home generation', async () => {
    process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), 'agor-codex-auth-'));
    const base = { command: 'codex.auth-file' as const };

    await expect(
      handleCodexAuthFile(
        {
          ...base,
          params: {
            operation: 'write',
            content: '{"tokens":{"refresh_token":"new"}}\n',
            generation: 20,
          },
        },
        {}
      )
    ).resolves.toMatchObject({ success: true });
    await expect(
      handleCodexAuthFile(
        {
          ...base,
          params: {
            operation: 'write',
            content: '{"tokens":{"refresh_token":"stale-secret"}}\n',
            generation: 19,
          },
        },
        {}
      )
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'AUTH_FILE_STALE' },
    });
    expect(await readFile(join(process.env.CODEX_HOME, 'auth.json'), 'utf8')).toBe(
      '{"tokens":{"refresh_token":"new"}}\n'
    );

    await expect(
      handleCodexAuthFile({ ...base, params: { operation: 'delete', generation: 21 } }, {})
    ).resolves.toMatchObject({ success: true });
    await expect(
      handleCodexAuthFile(
        {
          ...base,
          params: {
            operation: 'write',
            content: '{"tokens":{"refresh_token":"resurrected"}}\n',
            generation: 20,
          },
        },
        {}
      )
    ).resolves.toMatchObject({ success: false, error: { code: 'AUTH_FILE_STALE' } });
    expect(await readdir(process.env.CODEX_HOME)).toEqual(['.agor-auth-generation']);
  });
});
