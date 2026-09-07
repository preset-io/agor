import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetConfigCacheForTests, getConfigPath, loadConfigSync } from './config-manager';

/**
 * Config resolution must not depend on the machine running the tests.
 *
 * The failure this pins down: config validation rejects unrecognized keys, so a
 * `~/.agor/config.yaml` written by a newer build is fatal to older code. A
 * contributor who runs a recent daemon and then checks out an older branch gets
 * whole test files failing at setup, naming config keys the branch has never
 * heard of — which reads as a broken environment rather than a test-isolation
 * bug. `test/isolate-host-env.ts` is what keeps that off the default path.
 */

/** A key no schema version recognizes — stands in for one from a newer build. */
const KEY_FROM_A_NEWER_BUILD = 'a_key_this_build_does_not_know';

const SHARED_SETUP = 'test/isolate-host-env.ts';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  __resetConfigCacheForTests();
});

describe('host config isolation', () => {
  it('rejects a config carrying a key this build does not recognize', () => {
    // The scenario a contributor hits, staged against a fixture home so the
    // assertion holds on every machine. If this stops throwing, the isolation
    // below is guarding a hazard that no longer exists.
    const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'agor-host-home-fixture-'));
    mkdirSync(path.join(fixtureHome, '.agor'), { recursive: true });
    writeFileSync(
      path.join(fixtureHome, '.agor', 'config.yaml'),
      `daemon:\n  ${KEY_FROM_A_NEWER_BUILD}: true\n`
    );

    process.env.HOME = fixtureHome;
    process.env.USERPROFILE = fixtureHome;
    __resetConfigCacheForTests();

    expect(() => loadConfigSync()).toThrowError(
      new RegExp(`unrecognized keys?.*${KEY_FROM_A_NEWER_BUILD}`, 's')
    );
  });

  it('resolves config inside the isolated home rather than the host home', () => {
    const isolatedHome = process.env.AGOR_TEST_HOME;
    const hostHome = process.env.AGOR_TEST_HOST_HOME;

    // Absent means the setup file never ran — isolation off, not passing.
    expect(isolatedHome, 'test/isolate-host-env.ts did not run').toBeTruthy();
    expect(hostHome, 'test/isolate-host-env.ts did not run').toBeTruthy();
    expect(isolatedHome).not.toBe(hostHome);

    expect(os.homedir()).toBe(isolatedHome);
    expect(getConfigPath()).toBe(path.join(String(isolatedHome), '.agor', 'config.yaml'));
    expect(getConfigPath().startsWith(String(hostHome))).toBe(false);
  });

  it('falls back to defaults instead of reading whatever the host config says', () => {
    // The isolated home is deliberately empty, so this is the documented
    // no-config path. It must not throw over the host's config contents.
    expect(() => loadConfigSync()).not.toThrow();
  });
});

describe('workspace vitest projects', () => {
  function findRepoRoot(from: string): string {
    let dir = from;
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
      dir = path.dirname(dir);
    }
    throw new Error(`No pnpm-workspace.yaml above ${from}`);
  }

  function listVitestConfigs(root: string): string[] {
    const found: string[] = [];
    for (const workspace of ['apps', 'packages']) {
      let entries: string[];
      try {
        entries = readdirSync(path.join(root, workspace));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const relative = path.join(workspace, entry, 'vitest.config.ts');
        if (existsSync(path.join(root, relative))) found.push(relative);
      }
    }
    return found;
  }

  // A project that forgets the shared setup silently reads the developer's real
  // config, and nothing in that project fails to say so. Checking every project
  // here makes adding one without isolation a failing test, rather than a
  // discovery someone makes months later from a confusing stack trace.
  it('every vitest project loads the shared host-env isolation setup', () => {
    const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
    const configs = listVitestConfigs(repoRoot);

    // Guards the walk itself: if it ever finds nothing, the check below passes
    // vacuously and this test protects nothing.
    expect(configs.length).toBeGreaterThanOrEqual(8);

    const missing = configs.filter(
      (file) => !readFileSync(path.join(repoRoot, file), 'utf-8').includes(SHARED_SETUP)
    );

    expect(missing).toEqual([]);
  });
});
