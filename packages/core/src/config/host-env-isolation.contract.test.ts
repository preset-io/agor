import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getConfigPath, loadConfigSync } from './config-manager';

/**
 * Check test-runner isolation here; config-manager.test.ts owns validation
 * policy, including strict and forward-compatible unknown-key handling.
 */

const SHARED_SETUP = 'test/isolate-host-env.ts';

describe('host config isolation', () => {
  it('resolves config inside the isolated home rather than the host home', () => {
    const isolatedHome = process.env.AGOR_TEST_HOME;
    const hostHome = process.env.AGOR_TEST_HOST_HOME;

    // Absent means the setup file never ran — isolation off, not passing.
    expect(isolatedHome, 'test/isolate-host-env.ts did not run').toBeTruthy();
    expect(hostHome, 'test/isolate-host-env.ts did not run').toBeTruthy();
    expect(isolatedHome).not.toBe(hostHome);

    expect(os.homedir()).toBe(isolatedHome);
    expect(getConfigPath()).toBe(path.join(String(isolatedHome), '.agor', 'config.yaml'));
    // A temp home may live beneath the host home (e.g. TMPDIR=~/tmp).
    expect(getConfigPath()).not.toBe(path.join(String(hostHome), '.agor', 'config.yaml'));
    expect(existsSync(getConfigPath())).toBe(false);
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
      const entries = readdirSync(path.join(root, workspace));
      for (const entry of entries) {
        const relative = path.join(workspace, entry, 'vitest.config.ts');
        if (existsSync(path.join(root, relative))) found.push(relative);
      }
    }
    return found;
  }

  // These sibling configs are Turbo globalDependencies: changing another
  // package's setup wiring must invalidate this package's cached contract test.
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
