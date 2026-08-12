import { describe, expect, it, vi } from 'vitest';

const { createGit, resolveGitBinary, version } = vi.hoisted(() => ({
  createGit: vi.fn(),
  resolveGitBinary: vi.fn(),
  version: vi.fn(),
}));

vi.mock('@agor/core/git', () => ({ createGit, resolveGitBinary }));

import { diagnoseGit } from './git-diagnostics.js';

describe('diagnoseGit', () => {
  it('runs simple-git version against the configured executable', async () => {
    resolveGitBinary.mockReturnValue('/usr/bin/git');
    createGit.mockReturnValue({ git: { version } });
    version.mockResolvedValue({ installed: true, major: 2, minor: 39, patch: 5 });
    await expect(diagnoseGit()).resolves.toEqual({
      status: 'ready',
      binary: '/usr/bin/git',
      version: '2.39.5',
    });
  });

  it('preserves the actionable missing-Git message', async () => {
    resolveGitBinary.mockImplementation(() => {
      throw new Error('Git executable is unavailable. Install Git.');
    });
    await expect(diagnoseGit()).resolves.toEqual({
      status: 'missing',
      detail: 'Git executable is unavailable. Install Git.',
    });
  });

  it('honors simple-git installed=false', async () => {
    resolveGitBinary.mockReturnValue('git');
    createGit.mockReturnValue({ git: { version } });
    version.mockResolvedValue({ installed: false, major: 0, minor: 0, patch: 0 });
    await expect(diagnoseGit()).resolves.toEqual({
      status: 'missing',
      detail:
        'Git executable is unavailable. Install Git, ensure it is executable on PATH, and verify `git --version` before retrying.',
    });
  });
});
