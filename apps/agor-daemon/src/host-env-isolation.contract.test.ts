import os from 'node:os';
import path from 'node:path';
import { getConfigPath, loadConfigSync } from '@agor/core/config';
import { describe, expect, it } from 'vitest';

// Keep a local smoke check for developers running only the daemon suite.
const WIRING =
  'Daemon host-env isolation is missing. Check setupFiles in apps/agor-daemon/vitest.config.ts ' +
  'and run Vitest from that package, not the repo root.';

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
