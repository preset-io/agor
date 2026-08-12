import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseGit, resolveGitBinary } from './index';

describe('resolveGitBinary', () => {
  it('prefers an executable common absolute path', () => {
    expect(
      resolveGitBinary({
        path: '/custom/bin',
        commonPaths: ['/system/git', '/other/git'],
        isExecutable: (candidate) => candidate === '/system/git',
      })
    ).toBe('/system/git');
  });

  it('searches PATH without invoking a shell', () => {
    const path = ['/first/bin', '/managed/bin'].join(delimiter);
    const expectedGit = join('/managed/bin', 'git');
    expect(
      resolveGitBinary({
        path,
        commonPaths: [],
        isExecutable: (candidate) => candidate === expectedGit,
      })
    ).toBe(expectedGit);
  });

  it('fails with an actionable error when Git is absent', () => {
    expect(() =>
      resolveGitBinary({ path: '', commonPaths: [], isExecutable: () => false })
    ).toThrow(
      'Git executable is unavailable. Install Git, ensure it is executable on PATH, and verify `git --version` before retrying.'
    );
  });
});

describe('diagnoseGit', () => {
  it('reports a ready injected runtime without requiring host Git', async () => {
    await expect(
      diagnoseGit({
        resolveBinary: () => '/fixture/bin/git',
        version: async () => ({ installed: true, major: 2, minor: 47, patch: 1 }),
      })
    ).resolves.toMatchObject({
      status: 'ready',
      binary: '/fixture/bin/git',
      version: '2.47.1',
    });
  });

  it('reports a missing injected runtime with actionable detail', async () => {
    await expect(
      diagnoseGit({
        resolveBinary: () => '/fixture/bin/git',
        version: async () => ({ installed: false, major: 0, minor: 0, patch: 0 }),
      })
    ).resolves.toMatchObject({ status: 'missing', detail: expect.stringContaining('Install Git') });
  });
});
