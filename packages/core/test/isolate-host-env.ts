import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point HOME at an empty per-worker directory before any test runs.
 *
 * `getConfigPath()` resolves through `os.homedir()`, which reads `$HOME` on
 * POSIX. Without this, every suite that loads config reads whatever
 * `~/.agor/config.yaml` the machine happens to have — so results depend on the
 * developer's own settings, and a host whose config is unreadable (an executor
 * sandbox masks it with a `/dev/null` bind mount) fails hundreds of tests that
 * have nothing to do with config.
 *
 * The directory is left empty: absent config is the documented path to
 * `getDefaultConfig()`, so suites get deterministic defaults and any test
 * wanting real config writes one under its own temp HOME.
 *
 * Host env vars that feed the same resolution are cleared for the same reason.
 * Tests that care about them set them explicitly.
 */
const testHome = mkdtempSync(path.join(os.tmpdir(), 'agor-test-home-'));

// `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows; set both so
// the isolation doesn't quietly become a no-op on one platform.
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

delete process.env.AGOR_DATA_HOME;
delete process.env.AGOR_OUTER_SANDBOX;

// Production startup fails closed before repositories are constructed when
// the deployment key is absent. Mirror that invariant for repository tests;
// encryption-specific tests temporarily delete it when exercising fail-closed
// behavior.
process.env.AGOR_MASTER_SECRET = 'agor-core-test-master-secret-not-production';
