import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureWorktreeBuildSha, redactCommandForAudit } from './environment-command-spawn.js';

describe('captureWorktreeBuildSha', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-build-sha-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 7-char short SHA for a valid git repo', async () => {
    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(repoPath, { recursive: true });
    const git = simpleGit(repoPath);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    await fs.writeFile(path.join(repoPath, 'README.md'), '# Test', 'utf-8');
    await git.add('README.md');
    await git.commit('Initial commit');

    const sha = await captureWorktreeBuildSha(repoPath);
    expect(sha).toMatch(/^[0-9a-f]{7}$/);
  });

  it('returns undefined for a non-git path', async () => {
    const sha = await captureWorktreeBuildSha(tmpDir);
    expect(sha).toBeUndefined();
  });

  it('returns undefined for a nonexistent path', async () => {
    const sha = await captureWorktreeBuildSha(path.join(tmpDir, 'does-not-exist'));
    expect(sha).toBeUndefined();
  });

  it('returns undefined for a git repo with no commits', async () => {
    const repoPath = path.join(tmpDir, 'empty-repo');
    await fs.mkdir(repoPath, { recursive: true });
    const git = simpleGit(repoPath);
    await git.init(['--initial-branch=main']);

    const sha = await captureWorktreeBuildSha(repoPath);
    expect(sha).toBeUndefined();
  });
});

describe('redactCommandForAudit', () => {
  it('redacts inline TOKEN= assignments', () => {
    expect(redactCommandForAudit('GITHUB_TOKEN=ghp_abc123 docker compose up')).toBe(
      'GITHUB_TOKEN=*** docker compose up'
    );
  });

  it('redacts SECRET / PASSWORD / API_KEY suffixes', () => {
    expect(redactCommandForAudit('APP_SECRET=s3cret DB_PASSWORD=hunter2 run')).toBe(
      'APP_SECRET=*** DB_PASSWORD=*** run'
    );
    expect(redactCommandForAudit('STRIPE_API_KEY=sk_live_xxx node index.js')).toBe(
      'STRIPE_API_KEY=*** node index.js'
    );
  });

  it('is case-insensitive on the key name', () => {
    expect(redactCommandForAudit('my_token=abc run')).toBe('my_token=*** run');
  });

  it('leaves non-secret env vars alone', () => {
    expect(redactCommandForAudit('NODE_ENV=production PORT=3000 node .')).toBe(
      'NODE_ENV=production PORT=3000 node .'
    );
  });

  it('redacts at start of string without eating a leading char', () => {
    expect(redactCommandForAudit('TOKEN=abc docker')).toBe('TOKEN=*** docker');
  });

  it('truncates commands longer than the audit limit', () => {
    const long = `docker run ${'x'.repeat(2000)}`;
    const out = redactCommandForAudit(long);
    expect(out.length).toBeLessThanOrEqual(1024 + '…[truncated]'.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('preserves semicolon/pipe separators before key', () => {
    expect(redactCommandForAudit('echo ok; FOO_TOKEN=abc docker')).toBe(
      'echo ok; FOO_TOKEN=*** docker'
    );
  });
});
