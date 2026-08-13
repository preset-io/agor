import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
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
  { claudeAiOauth: { accessToken: 'sk-ant-oat01-secret', refreshToken: 'sk-ant-ort01-secret' } },
  null,
  2
)}\n`;

describe('claude.auth-file executor boundary', () => {
  it('atomically writes 0600, overwrites, and idempotently deletes in its own runtime home', async () => {
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
    // No leftover temp files from the atomic write.
    expect(await readdir(process.env.CLAUDE_CONFIG_DIR)).toEqual(['.credentials.json']);

    await handleClaudeAuthFile({ ...base, params: { operation: 'delete' } }, {});
    // Delete is idempotent — a second delete on an absent file still succeeds.
    expect(await handleClaudeAuthFile({ ...base, params: { operation: 'delete' } }, {})).toEqual({
      success: true,
      data: { status: 'deleted' },
    });
    expect(await readdir(process.env.CLAUDE_CONFIG_DIR)).toEqual([]);
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
