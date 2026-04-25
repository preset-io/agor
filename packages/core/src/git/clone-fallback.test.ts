/**
 * Unit tests for cloneRepo HTTPS→SSH fallback behaviour.
 *
 * These tests mock simple-git's clone call so we can exercise the retry logic
 * without making real network requests. They live in a separate file so the
 * module-level vi.mock calls don't bleed into the integration-style tests in
 * index.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Module mocks (hoisted automatically by Vitest) ───────────────────────

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', async () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
}));

vi.mock('simple-git');

// ─── Imports (after mocks) ────────────────────────────────────────────────

import os from 'node:os';
import * as simpleGitModule from 'simple-git';
import { cloneRepo, isAuthRelatedGitError } from './index';

// ─── isAuthRelatedGitError unit tests ─────────────────────────────────────

describe('isAuthRelatedGitError', () => {
  it.each([
    'Authentication failed',
    'could not read Username for https://github.com',
    'could not read Password',
    'Permission denied (publickey)',
    'terminal prompts disabled',
    'remote: Repository not found.',
    'ERROR: Repository not found.',
    'Access denied',
    'remote: not found',
  ])('returns true for auth-related message: %s', (msg) => {
    expect(isAuthRelatedGitError(new Error(msg))).toBe(true);
  });

  it.each([
    'network timeout',
    'Could not resolve host: github.com',
    'Connection refused',
    'fatal: unable to connect',
  ])('returns false for non-auth message: %s', (msg) => {
    expect(isAuthRelatedGitError(new Error(msg))).toBe(false);
  });
});

// ─── cloneRepo HTTPS→SSH fallback tests ───────────────────────────────────

describe('cloneRepo – HTTPS→SSH fallback', () => {
  let mockClone: ReturnType<typeof vi.fn>;
  let mockRaw: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/tmp/agor-test-home');

    mockClone = vi.fn();
    mockRaw = vi.fn().mockResolvedValue('refs/remotes/origin/main');

    const mockGitInstance = {
      clone: mockClone,
      outputHandler: vi.fn().mockReturnThis(),
      raw: mockRaw,
      branch: vi.fn().mockResolvedValue({ current: 'main' }),
    };

    vi.mocked(simpleGitModule.simpleGit).mockReturnValue(mockGitInstance as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clones a public HTTPS URL directly without SSH fallback when clone succeeds', async () => {
    mockClone.mockResolvedValueOnce(undefined);

    const result = await cloneRepo({
      url: 'https://github.com/user/public-repo.git',
      targetDir: '/tmp/agor-test-home/.agor/repos/public-repo',
    });

    expect(mockClone).toHaveBeenCalledTimes(1);
    expect(mockClone).toHaveBeenCalledWith(
      'https://github.com/user/public-repo.git',
      '/tmp/agor-test-home/.agor/repos/public-repo',
      []
    );
    expect(result.repoName).toBe('public-repo');
  });

  it('falls back to SSH when HTTPS fails with auth error and SSH_AUTH_SOCK is set', async () => {
    mockClone
      .mockRejectedValueOnce(new Error('remote: Repository not found.\nfatal: repository not found'))
      .mockResolvedValueOnce(undefined);

    const result = await cloneRepo({
      url: 'https://github.com/user/private-repo.git',
      targetDir: '/tmp/agor-test-home/.agor/repos/private-repo',
      env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
    });

    expect(mockClone).toHaveBeenCalledTimes(2);
    expect(mockClone).toHaveBeenNthCalledWith(
      1,
      'https://github.com/user/private-repo.git',
      '/tmp/agor-test-home/.agor/repos/private-repo',
      []
    );
    expect(mockClone).toHaveBeenNthCalledWith(
      2,
      'git@github.com:user/private-repo.git',
      '/tmp/agor-test-home/.agor/repos/private-repo',
      []
    );
    expect(result.repoName).toBe('private-repo');
  });

  it('appends .git suffix when converting bare HTTPS path to SSH', async () => {
    mockClone
      .mockRejectedValueOnce(new Error('Authentication failed'))
      .mockResolvedValueOnce(undefined);

    await cloneRepo({
      url: 'https://github.com/org/repo-no-suffix',
      targetDir: '/tmp/agor-test-home/.agor/repos/repo-no-suffix',
      env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
    });

    expect(mockClone).toHaveBeenNthCalledWith(
      2,
      'git@github.com:org/repo-no-suffix.git',
      '/tmp/agor-test-home/.agor/repos/repo-no-suffix',
      []
    );
  });

  it('does NOT fall back to SSH when SSH_AUTH_SOCK is not set', async () => {
    mockClone.mockRejectedValueOnce(new Error('Authentication failed'));

    await expect(
      cloneRepo({
        url: 'https://github.com/user/private-repo.git',
        targetDir: '/tmp/agor-test-home/.agor/repos/private-repo',
        // no env / no SSH_AUTH_SOCK
      })
    ).rejects.toThrow('Authentication failed');

    expect(mockClone).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back to SSH when clone fails with a non-auth error', async () => {
    mockClone.mockRejectedValueOnce(new Error('network timeout'));

    await expect(
      cloneRepo({
        url: 'https://github.com/user/repo.git',
        targetDir: '/tmp/agor-test-home/.agor/repos/repo',
        env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
      })
    ).rejects.toThrow('network timeout');

    expect(mockClone).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back to SSH when a GITHUB_TOKEN is provided (even on auth failure)', async () => {
    // Simulate token injection path failing (e.g. wrong token shape stored)
    mockClone.mockRejectedValueOnce(new Error('Authentication failed'));

    await expect(
      cloneRepo({
        url: 'https://github.com/user/repo.git',
        targetDir: '/tmp/agor-test-home/.agor/repos/repo',
        env: {
          // Valid token shape so URL injection fires
          GITHUB_TOKEN: 'ghp_validtokenABCDEF123456789012345',
          SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
        },
      })
    ).rejects.toThrow('Authentication failed');

    // Only one attempt: the URL-injected HTTPS clone (no SSH fallback)
    expect(mockClone).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back to SSH for non-GitHub HTTPS URLs', async () => {
    mockClone.mockRejectedValueOnce(new Error('Authentication failed'));

    await expect(
      cloneRepo({
        url: 'https://gitlab.com/user/repo.git',
        targetDir: '/tmp/agor-test-home/.agor/repos/repo',
        env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
      })
    ).rejects.toThrow('Authentication failed');

    expect(mockClone).toHaveBeenCalledTimes(1);
  });

  it('bare clone flag is preserved in SSH fallback attempt', async () => {
    mockClone
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce(undefined);

    await cloneRepo({
      url: 'https://github.com/user/repo.git',
      targetDir: '/tmp/agor-test-home/.agor/repos/repo',
      env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
      bare: true,
    });

    expect(mockClone).toHaveBeenNthCalledWith(
      2,
      'git@github.com:user/repo.git',
      '/tmp/agor-test-home/.agor/repos/repo',
      ['--bare']
    );
  });
});
