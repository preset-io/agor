import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for the Codex subscription auth.json single-file bind
 * (design §8A.4, confirmed by the Phase-1 spike §8A.8).
 *
 * The whole subscription path rests on ONE kernel property: Codex's credential
 * refresh writes `auth.json` IN PLACE (open + truncate), NOT via a tempfile +
 * rename. A truncate-in-place write to a bind-mounted file preserves the inode,
 * so the write propagates back to the caller's REAL file outside the mount
 * namespace — meaning no credential is ever persisted into the shared branch
 * home. This test pins that property against the actual bwrap/kernel the daemon
 * uses, so it fails loudly if the assumption ever breaks.
 *
 * IMPORTANT — how to gate this on Codex SDK bumps: this test exercises the KERNEL
 * behavior with a stand-in `printf > file` (the same O_TRUNC-in-place write Codex
 * performs), NOT the shipped Codex binary — deliberately, so it needs no Codex
 * install, burns no single-use refresh token, and runs in CI. The complementary
 * obligation from §8A.4/§8B.2 is a SEPARATE test that drives the real
 * `codex login --with-api-key` (or a token refresh) through a bind-mounted
 * auth.json using DISPOSABLE credentials, wired to run on every
 * `@openai/codex-sdk` / codex-cli version bump (a rename-based write would fail
 * `EBUSY` on the mountpoint — so login *succeeding* is the proof). That one is
 * environment-gated and not included here to keep the default suite hermetic.
 */

function bwrapUsable(): boolean {
  if (process.platform !== 'linux') return false;
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-user', '--', 'true'], {
    stdio: 'ignore',
  });
  return probe.status === 0;
}

const RUN = bwrapUsable();

describe('Codex auth.json bind-mount write propagation (design §8A.4/§8A.8)', () => {
  it.runIf(RUN)(
    'truncate-in-place write through the bind lands on the real file, inode preserved',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'codex-authbind-'));
      // The caller's REAL auth.json (synthetic content — never a live token, per
      // §8A.8: real refresh tokens are single-use).
      const realDir = join(root, 'real', '.codex');
      mkdirSync(realDir, { recursive: true });
      const realAuth = join(realDir, 'auth.json');
      writeFileSync(realAuth, JSON.stringify({ OPENAI_API_KEY: 'before' }), { mode: 0o600 });

      // The (initially empty) branch-home codex dir + mountpoint file.
      const branchCodex = join(root, 'branch', 'codex');
      mkdirSync(branchCodex, { recursive: true });
      const branchAuth = join(branchCodex, 'auth.json');
      writeFileSync(branchAuth, '', { mode: 0o600 });

      const inodeBefore = statSync(realAuth).ino;

      // Bind the real auth.json onto the branch path (mirrors §7's single-file
      // bind), then write IN PLACE from inside the namespace via `> file`
      // (O_TRUNC) — exactly Codex's refresh write pattern.
      const result = spawnSync(
        'bwrap',
        [
          '--ro-bind',
          '/',
          '/',
          '--bind',
          realAuth,
          branchAuth,
          '--unshare-user',
          '--',
          'sh',
          '-c',
          `printf '%s' '{"OPENAI_API_KEY":"after"}' > '${branchAuth}'`,
        ],
        { stdio: 'ignore' }
      );
      expect(result.status).toBe(0);

      // The write must have reached the REAL outside file, same inode.
      expect(JSON.parse(readFileSync(realAuth, 'utf8'))).toEqual({ OPENAI_API_KEY: 'after' });
      expect(statSync(realAuth).ino).toBe(inodeBefore);
    }
  );

  it.skipIf(RUN)('SKIPPED: bwrap/user-namespaces unavailable on this host', () => {
    // Documents that the regression is intentionally skipped (not silently
    // absent) where the sandbox substrate cannot run — e.g. non-Linux or a host
    // that forbids unprivileged user namespaces.
    expect(RUN).toBe(false);
  });
});
