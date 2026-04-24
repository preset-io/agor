import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDevSha, loadBuildInfo } from './build-info';

/**
 * loadBuildInfo precedence:
 *   1. AGOR_BUILD_SHA env
 *   2. .build-info file (next to the daemon entry)
 *   3. git rev-parse --short HEAD
 *   4. 'dev'
 *
 * We test 1, 2, and 4 deterministically. (3) is environment-dependent so we
 * cover it implicitly: when env+file are absent inside the temp dir, the
 * loader either returns a real git SHA (when run from inside this repo) or
 * 'dev'. Both are valid outcomes; the test only asserts the source label.
 */

let tmpRoot: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agor-build-info-test-'));
  originalEnv = process.env.AGOR_BUILD_SHA;
  delete process.env.AGOR_BUILD_SHA;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (originalEnv === undefined) {
    delete process.env.AGOR_BUILD_SHA;
  } else {
    process.env.AGOR_BUILD_SHA = originalEnv;
  }
});

/**
 * loadBuildInfo() takes an `import.meta.url`-style file URL and walks up two
 * candidate paths looking for `.build-info`. Build a fake module URL inside
 * tmpRoot so each test controls its own filesystem.
 */
function fakeModuleUrl(): string {
  // Mirror the dist layout: <tmp>/setup/build-info.js
  const setupDir = join(tmpRoot, 'setup');
  mkdirSync(setupDir, { recursive: true });
  return pathToFileURL(join(setupDir, 'build-info.js')).toString();
}

describe('loadBuildInfo', () => {
  it('prefers AGOR_BUILD_SHA env over everything else', () => {
    process.env.AGOR_BUILD_SHA = 'env12345';
    process.env.AGOR_BUILT_AT = '2026-04-24T12:00:00Z';
    // Even with a file present, env wins.
    writeFileSync(join(tmpRoot, '.build-info'), JSON.stringify({ sha: 'file9999' }));

    const info = loadBuildInfo(fakeModuleUrl());
    expect(info.sha).toBe('env12345');
    expect(info.builtAt).toBe('2026-04-24T12:00:00Z');
    expect(info.source).toBe('env');

    delete process.env.AGOR_BUILT_AT;
  });

  it('falls back to .build-info file when env is unset', () => {
    writeFileSync(
      join(tmpRoot, '.build-info'),
      JSON.stringify({ sha: 'abc1234', builtAt: '2026-04-23T10:00:00Z' })
    );
    const info = loadBuildInfo(fakeModuleUrl());
    expect(info.sha).toBe('abc1234');
    expect(info.builtAt).toBe('2026-04-23T10:00:00Z');
    expect(info.source).toBe('file');
  });

  it('handles a .build-info file without builtAt', () => {
    writeFileSync(join(tmpRoot, '.build-info'), JSON.stringify({ sha: 'shaonly' }));
    const info = loadBuildInfo(fakeModuleUrl());
    expect(info.sha).toBe('shaonly');
    expect(info.builtAt).toBeNull();
    expect(info.source).toBe('file');
  });

  it('skips a malformed .build-info and falls through', () => {
    writeFileSync(join(tmpRoot, '.build-info'), 'not json');
    const info = loadBuildInfo(fakeModuleUrl());
    // Either git (if test runner happens to have git access from tmp) or dev.
    // Both are acceptable here; the file itself was rejected.
    expect(info.source === 'git' || info.source === 'fallback').toBe(true);
    if (info.source === 'fallback') expect(info.sha).toBe('dev');
  });

  it("returns 'dev' fallback when nothing is resolvable", () => {
    // tmpRoot has no .build-info, no env, and is not a git checkout.
    const info = loadBuildInfo(fakeModuleUrl());
    if (info.source === 'fallback') {
      expect(info.sha).toBe('dev');
      expect(info.builtAt).toBeNull();
    } else {
      // Git found one — fine, but at minimum the SHA must be non-empty.
      expect(info.sha.length).toBeGreaterThan(0);
    }
  });
});

describe('isDevSha', () => {
  it("returns true for 'dev' and falsy values", () => {
    expect(isDevSha('dev')).toBe(true);
    expect(isDevSha('')).toBe(true);
    expect(isDevSha(null)).toBe(true);
    expect(isDevSha(undefined)).toBe(true);
  });

  it('returns false for any concrete SHA', () => {
    expect(isDevSha('abc1234')).toBe(false);
    expect(isDevSha('deadbeef')).toBe(false);
  });
});
