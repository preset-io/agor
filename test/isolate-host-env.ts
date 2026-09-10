import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach } from 'vitest';

/**
 * Isolate Node-based Vitest projects from the host's ~/.agor/config.yaml and
 * data paths. An empty temporary home gives config loaders their defaults;
 * tests needing configuration can set their own temporary HOME.
 *
 * Every workspace vitest.config.ts loads this before test modules. The core
 * contract test checks that wiring; Turbo hashes this shared file globally.
 */

/** The developer's actual home — recorded only so tests can assert we left it. */
const hostHome = os.homedir();

const testHome = mkdtempSync(path.join(os.tmpdir(), 'agor-test-home-'));

// `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows; set both so
// the isolation doesn't quietly become a no-op on one platform.
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

delete process.env.AGOR_DATA_HOME;
delete process.env.AGOR_OUTER_SANDBOX;

// Production startup fails closed before repositories are constructed when the
// deployment key is absent. Mirror that invariant for repository tests;
// encryption-specific tests temporarily delete it when exercising fail-closed
// behavior.
process.env.AGOR_MASTER_SECRET = 'agor-test-master-secret-not-production';

/** Where this worker's isolated home lives. Read by the contract test. */
export const AGOR_TEST_HOME_ENV = 'AGOR_TEST_HOME';
/** The home we navigated away from. Read by the contract test. */
export const AGOR_TEST_HOST_HOME_ENV = 'AGOR_TEST_HOST_HOME';

process.env[AGOR_TEST_HOME_ENV] = testHome;
process.env[AGOR_TEST_HOST_HOME_ENV] = hostHome;

// Catch accidental restoration at the next test boundary. Tests may still
// switch to their own temporary homes.
beforeEach(() => {
  for (const name of ['HOME', 'USERPROFILE'] as const) {
    if (process.env[name] === hostHome) {
      throw new Error(
        `${name} was restored to the host home during this run, so config resolution ` +
          `is no longer hermetic. Point it at a temp directory instead of the value ` +
          `captured before test/isolate-host-env.ts ran.`
      );
    }
  }
});
