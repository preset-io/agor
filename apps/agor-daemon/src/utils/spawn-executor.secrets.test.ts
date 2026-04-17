/**
 * Regression tests: spawn-executor log hygiene.
 *
 * Runtime behavior is tested in packages/core/src/unix/run-as-user.test.ts
 * (the REGRESSION test that secret values never land in argv). Here we
 * guard the *caller* (spawn-executor) against re-introducing the old
 * dangerous log patterns and against forgetting to route secret env vars
 * through writeUserEnvFile.
 *
 * Source-level checks keep this test fast and free of any dependency on
 * @agor/core being built, which matters because in normal dev the daemon
 * runs against live TS via watch mode.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Mirror of the secret-key pattern from @agor/core/unix/run-as-user. Kept
// inline here to avoid any build-order dependency on @agor/core when running
// daemon tests in isolation. If these diverge, the core test suite will flag
// a mismatch via its own comprehensive SECRET_ENV_KEY_PATTERN coverage.
const LOCAL_SECRET_KEY_PATTERN = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_KEY)$|^OAUTH_/i;
const isSecretEnvKey = (name: string): boolean => LOCAL_SECRET_KEY_PATTERN.test(name);

const here = dirname(fileURLToPath(import.meta.url));
const spawnExecutorPath = join(here, 'spawn-executor.ts');
const source = readFileSync(spawnExecutorPath, 'utf8');

describe('spawn-executor log hygiene (source-level)', () => {
  it('does not log the full sudo command line (argv containing inlined secrets)', () => {
    // The old code did `console.log('Full command:', cmd + args.join(' '))`.
    // That string would include sudo ... bash -c 'env ANTHROPIC_API_KEY=... node ...'.
    expect(source).not.toMatch(/Full command/i);
    expect(source).not.toMatch(/\$\{\s*cmd\s*\}\s*\$\{\s*args\./);
  });

  it('does not console.log the whole env map under impersonation', () => {
    // Catches `console.log(..., envWithDaemonUrl)` or spreading it into a log.
    // Safe patterns (`Object.keys(...).filter(...)`) are allowed.
    // This matches a direct interpolation of the env object in a template.
    expect(source).not.toMatch(/\$\{\s*envWithDaemonUrl\s*\}/);
    expect(source).not.toMatch(/console\.log\([^)]*,\s*envWithDaemonUrl\s*\)/);
  });

  it('does not log env var key names directly (old Env vars being passed: line)', () => {
    // Old code printed `Env vars being passed: ${keys}`. Key names like
    // ANTHROPIC_API_KEY in logs are already useful to an attacker scraping
    // logs for valuable targets. Current safe summary filters with isSecretEnvKey.
    expect(source).not.toMatch(/Env vars being passed/);
  });

  it('routes secret env vars through the impersonation-env helper', () => {
    // Uses `prepareImpersonationEnv` (DRY: splits + writes env-file in one call)
    // rather than open-coding the secret/inline split per call site.
    expect(source).toMatch(/prepareImpersonationEnv\s*\(/);
    // Still uses isSecretEnvKey for the safe log-summary filter.
    expect(source).toMatch(/isSecretEnvKey\s*\(/);
  });

  it('registers a best-effort cleanup via attachEnvFileCleanup', () => {
    // New helper that sudo-unlinks the file when asUser owns it, so it works
    // under sticky /tmp where the daemon cannot unlink files owned by asUser.
    expect(source).toMatch(/attachEnvFileCleanup\s*\(/);
  });
});

describe('isSecretEnvKey matches the keys spawn-executor cares about', () => {
  // Same allowlist that spawn-executor inherits from process.env.
  const relevantKeys = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ];

  for (const key of relevantKeys) {
    it(`treats ${key} as secret`, () => {
      expect(isSecretEnvKey(key)).toBe(true);
    });
  }

  // And non-secret ones stay non-secret.
  const nonSecretKeys = ['PATH', 'NODE_ENV', 'DAEMON_URL', 'ANTHROPIC_BASE_URL'];
  for (const key of nonSecretKeys) {
    it(`does not treat ${key} as secret`, () => {
      expect(isSecretEnvKey(key)).toBe(false);
    });
  }
});
