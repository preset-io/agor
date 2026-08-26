import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleClaudeAuthFile } from './claude-auth-file.js';

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

const base = { command: 'claude.auth-file' as const };
const credentials = `${JSON.stringify(
  {
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-secret',
      refreshToken: 'sk-ant-ort01-secret',
      expiresAt: 1_800_000_000_000,
    },
  },
  null,
  2
)}\n`;

describe('claude.auth-file executor boundary', () => {
  it('writes 0600 authority and idempotently tombstones in its runtime home', async () => {
    process.env.CLAUDE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'agor-claude-auth-'));
    const target = join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');

    expect(
      await handleClaudeAuthFile({ ...base, params: { operation: 'write', content: 'old' } }, {})
    ).toEqual({ success: true, data: { status: 'written' } });
    await handleClaudeAuthFile(
      { ...base, params: { operation: 'write', content: credentials } },
      {}
    );

    expect(await readFile(target, 'utf8')).toBe(credentials);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await readdir(process.env.CLAUDE_CONFIG_DIR)).sort()).toEqual(
      process.platform === 'linux'
        ? ['.agor-auth-mutation.lock', '.credentials.json']
        : ['.credentials.json']
    );

    await handleClaudeAuthFile({ ...base, params: { operation: 'delete' } }, {});
    // Delete is an empty, inode-stable tombstone; repeating it still succeeds.
    expect(await handleClaudeAuthFile({ ...base, params: { operation: 'delete' } }, {})).toEqual({
      success: true,
      data: { status: 'deleted' },
    });
    expect(await readFile(target, 'utf8')).toBe('');
    expect((await readdir(process.env.CLAUDE_CONFIG_DIR)).sort()).toEqual(
      process.platform === 'linux'
        ? ['.agor-auth-mutation.lock', '.credentials.json']
        : ['.credentials.json']
    );
  });

  it('inspect reports found / not-found / malformed without echoing token bytes', async () => {
    process.env.CLAUDE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'agor-claude-auth-'));

    expect(await handleClaudeAuthFile({ ...base, params: { operation: 'inspect' } }, {})).toEqual({
      success: true,
      data: { status: 'not-found' },
    });

    await writeFile(join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), '');
    expect(await handleClaudeAuthFile({ ...base, params: { operation: 'inspect' } }, {})).toEqual({
      success: true,
      data: { status: 'not-found' },
    });

    await handleClaudeAuthFile(
      { ...base, params: { operation: 'write', content: credentials } },
      {}
    );
    const found = await handleClaudeAuthFile({ ...base, params: { operation: 'inspect' } }, {});
    expect(found).toEqual({ success: true, data: { status: 'found' } });
    expect(JSON.stringify(found)).not.toContain('secret');

    await handleClaudeAuthFile(
      { ...base, params: { operation: 'write', content: '{"claudeAiOauth":{}}\n' } },
      {}
    );
    expect(await handleClaudeAuthFile({ ...base, params: { operation: 'inspect' } }, {})).toEqual({
      success: true,
      data: { status: 'malformed' },
    });
  });

  it('generation-fences a stale delegated delete behind a newer credential write', async () => {
    process.env.CLAUDE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'agor-claude-auth-'));
    const target = join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');
    expect(
      await handleClaudeAuthFile(
        { ...base, params: { operation: 'write', content: credentials, generation: 30 } },
        {}
      )
    ).toEqual({ success: true, data: { status: 'written' } });

    const stale = await handleClaudeAuthFile(
      { ...base, params: { operation: 'delete', generation: 20 } },
      {}
    );
    expect(stale).toMatchObject({ success: false, error: { code: 'AUTH_FILE_STALE' } });
    expect(await readFile(target, 'utf8')).toBe(credentials);
  });

  it('does not spawn or write in dryRun mode', async () => {
    process.env.CLAUDE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'agor-claude-auth-'));
    const result = await handleClaudeAuthFile(
      { ...base, params: { operation: 'write', content: credentials } },
      { dryRun: true }
    );
    expect(result).toEqual({ success: true, data: { operation: 'write', dryRun: true } });
    expect(await readdir(process.env.CLAUDE_CONFIG_DIR)).toEqual([]);
  });

  it('reports a sanitized verify failure without echoing credential bytes', async () => {
    process.env.CLAUDE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'agor-claude-auth-'));
    // A directory at the target path makes the read-back fail; the error must
    // not carry any credential material.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'));
    const result = await handleClaudeAuthFile(
      { ...base, params: { operation: 'write', content: credentials } },
      {}
    ).catch((err) => ({ threw: String(err) }));
    expect(JSON.stringify(result)).not.toContain('secret');
    await rm(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  });
});
