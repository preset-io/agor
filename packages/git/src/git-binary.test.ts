import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveGitBinary } from './git-binary';

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
    expect(
      resolveGitBinary({
        path,
        commonPaths: [],
        isExecutable: (candidate) => candidate === '/managed/bin/git',
      })
    ).toBe('/managed/bin/git');
  });

  it('fails with an actionable error when Git is absent', () => {
    expect(() =>
      resolveGitBinary({ path: '', commonPaths: [], isExecutable: () => false })
    ).toThrow(
      'Git executable is unavailable. Install Git, ensure it is executable on PATH, and verify `git --version` before retrying.'
    );
  });
});
