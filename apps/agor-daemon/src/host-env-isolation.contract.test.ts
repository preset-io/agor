import os from 'node:os';
import path from 'node:path';
import { getConfigPath, loadConfigSync } from '@agor/core/config';
import { describe, expect, it } from 'vitest';

/**
 * The daemon suite states its own isolation.
 *
 * `packages/core` already checks that every workspace config loads the shared
 * `test/isolate-host-env.ts`, but that check only runs when the core suite
 * runs. A daemon developer running only this package would otherwise learn
 * that isolation was missing the slow way: `loadConfig()` reads the real
 * `~/.agor/config.yaml`, validation rejects a key written by a newer build,
 * and dozens of unrelated files fail with `Config error: unrecognized keys`.
 * That reads as a broken machine rather than missing wiring, and has sent at
 * least one investigation down a long false trail.
 *
 * So this file fails first, and says which it is.
 */

const WIRING = [
  'Host-env isolation is not active for the daemon suite.',
  '',
  'Two known causes:',
  '  1. apps/agor-daemon/vitest.config.ts lost its setupFiles entry for',
  '     ../../test/isolate-host-env.ts',
  '  2. Vitest was run from the repo root, so no project config applied.',
  '     Run from this package: cd apps/agor-daemon && pnpm vitest run <path>',
  '',
  'Until it is fixed this suite reads your real ~/.agor/config.yaml, and any',
  '"Config error: unrecognized keys" failures are a symptom of that — not a',
  'problem with your config. Do not edit your config to make them go away.',
].join('\n');

describe('daemon host-env isolation', () => {
  it("resolves config inside an isolated home, not the developer's own", () => {
    const isolatedHome = process.env.AGOR_TEST_HOME;

    expect(isolatedHome, WIRING).toBeTruthy();
    expect(os.homedir(), WIRING).toBe(isolatedHome);
    expect(getConfigPath()).toBe(path.join(String(isolatedHome), '.agor', 'config.yaml'));

    // The isolated home is empty, so this is the documented no-config path.
    // It must not throw over whatever the host's config happens to contain.
    expect(() => loadConfigSync()).not.toThrow();
  });
});
