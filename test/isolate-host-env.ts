import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach } from 'vitest';

/**
 * Point HOME at an empty per-worker directory before any test runs.
 *
 * `getConfigPath()` resolves through `os.homedir()`, which reads `$HOME` on
 * POSIX. Without this, every suite that loads config reads whatever
 * `~/.agor/config.yaml` the machine happens to have. Two failure modes follow,
 * and both look like a bug in the code under test:
 *
 *  - Config validation rejects unrecognized keys, so a config written by a
 *    newer build is fatal to an older one. Check out a branch that predates a
 *    key your daemon already wrote and whole files fail at setup, naming
 *    config keys that have nothing to do with the test.
 *  - A host whose config is unreadable (an executor sandbox masks it with a
 *    `/dev/null` bind mount) fails hundreds of tests the same way.
 *
 * This file is the single copy for the whole workspace: every
 * `vitest.config.ts` lists it in `setupFiles`, and
 * `packages/core/src/config/host-env-isolation.contract.test.ts` fails if a
 * project stops doing so. Isolation that each new harness has to remember is
 * isolation that eventually gets forgotten.
 *
 * The directory is left empty: absent config is the documented path to
 * `getDefaultConfig()`, so suites get deterministic defaults, and a test that
 * wants real config writes one under its own temp HOME.
 *
 * Host env vars that feed the same resolution are cleared for the same reason.
 * Tests that care about them set them explicitly.
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

// Setting HOME once is not the same as it staying set. A test that restores a
// saved HOME in `afterEach`, or stubs it without unstubbing, silently hands the
// rest of the file the developer's real config. Catch that at the boundary of
// the next test rather than as a confusing failure somewhere downstream.
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
