import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point HOME at an empty per-worker directory before any test runs.
 *
 * Mirrors `packages/core/test/isolate-host-env.ts` — kept local rather than
 * imported across the package boundary so neither test suite depends on the
 * other's layout. See that file for the full rationale: config resolution goes
 * through `os.homedir()`, so without this every suite that loads config reads
 * the machine's own `~/.agor/config.yaml`.
 */
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'agor-daemon-test-home-'));

delete process.env.AGOR_DATA_HOME;
delete process.env.AGOR_OUTER_SANDBOX;
