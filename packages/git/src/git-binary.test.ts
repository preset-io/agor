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
  it('exercises the configured simple-git runtime', async () => {
    await expect(diagnoseGit()).resolves.toMatchObject({
      status: 'ready',
      binary: expect.any(String),
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
  });
});
