import { mkdir, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
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
});
