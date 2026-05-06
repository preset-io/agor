/**
 * Tests for the env-var-based git auth plumbing.
 *
 * These cover the helpers that replaced the previous `credential.helper` +
 * on-disk tempfile approach (PR #1099 → follow-up):
 *
 *   - `buildGitConfigEnv` — emits the GIT_CONFIG_COUNT/KEY_N/VALUE_N trio.
 *   - `buildAuthHeaderEnv` — encodes a token as a per-host extraheader.
 *   - `redactGitEnv` — masks any GIT_CONFIG_VALUE_N carrying an Authorization
 *     header before serialisation (e.g. into logs / error reports).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthHeaderEnv,
  buildGitConfigEnv,
  createGit,
  parseHostFromGitUrl,
  redactGitEnv,
} from './index';

describe('buildGitConfigEnv', () => {
  it('returns an empty object for no entries (so callers can spread unconditionally)', () => {
    expect(buildGitConfigEnv([])).toEqual({});
  });

  it('emits COUNT + KEY_n / VALUE_n pairs in order', () => {
    const env = buildGitConfigEnv([
      ['core.sshCommand', 'ssh -F /dev/null'],
      ['http.extraheader', 'Authorization: Basic abc'],
    ]);
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.sshCommand',
      GIT_CONFIG_VALUE_0: 'ssh -F /dev/null',
      GIT_CONFIG_KEY_1: 'http.extraheader',
      GIT_CONFIG_VALUE_1: 'Authorization: Basic abc',
    });
  });
});

describe('buildAuthHeaderEnv', () => {
  // A plausible-shape PAT (matches isLikelyGitToken's /^[A-Za-z0-9_-]{20,255}$/).
  const TOKEN = `ghp_${'x'.repeat(36)}`;

  it('returns [] when no token is supplied (caller can spread unconditionally)', () => {
    expect(buildAuthHeaderEnv(undefined)).toEqual([]);
    expect(buildAuthHeaderEnv('')).toEqual([]);
  });

  it('returns [] for malformed tokens (fail loud rather than emit a corrupt header)', () => {
    // Quiet the warn so vitest output stays clean
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildAuthHeaderEnv('not a token; rm -rf /')).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('encodes "x-access-token:<token>" as Basic auth and scopes to host', () => {
    const entries = buildAuthHeaderEnv(TOKEN);
    expect(entries).toHaveLength(1);
    const [key, value] = entries[0];
    expect(key).toBe('http.https://github.com/.extraheader');

    const expectedB64 = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64');
    expect(value).toBe(`Authorization: Basic ${expectedB64}`);
  });

  it('honors a custom host (per-host scoping prevents submodule token leak)', () => {
    const [[key]] = buildAuthHeaderEnv(TOKEN, 'gitlab.example.com');
    expect(key).toBe('http.https://gitlab.example.com/.extraheader');
  });
});

describe('redactGitEnv', () => {
  it('masks GIT_CONFIG_VALUE_n entries containing Authorization:', () => {
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic dG9wOnNlY3JldA==',
      PATH: '/usr/bin',
    };
    const out = redactGitEnv(env);
    expect(out.GIT_CONFIG_VALUE_0).toBe('<redacted>');
    // Non-VALUE entries pass through verbatim.
    expect(out.GIT_CONFIG_COUNT).toBe('1');
    expect(out.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(out.PATH).toBe('/usr/bin');
  });

  it('does not redact unrelated VALUE entries', () => {
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.sshCommand',
      GIT_CONFIG_VALUE_0: 'ssh -F /dev/null',
    };
    expect(redactGitEnv(env).GIT_CONFIG_VALUE_0).toBe('ssh -F /dev/null');
  });

  it('only masks the VALUE_n shape — values elsewhere pass through unchanged', () => {
    // Defensive: a user-set env literally named `Authorization` is *not* the
    // shape we care about. Only `GIT_CONFIG_VALUE_<n>` carrying an
    // `Authorization:` header is masked.
    const env = { Authorization: 'Bearer abc' };
    expect(redactGitEnv(env).Authorization).toBe('Bearer abc');
  });

  it('handles undefined values without crashing', () => {
    const env: Record<string, string | undefined> = {
      GIT_CONFIG_VALUE_0: undefined,
      KEEP: 'kept',
    };
    const out = redactGitEnv(env);
    expect(out).toEqual({ KEEP: 'kept' });
  });

  it('is case-insensitive on the Authorization marker', () => {
    const env = {
      GIT_CONFIG_VALUE_0: 'authorization: BASIC abc',
    };
    expect(redactGitEnv(env).GIT_CONFIG_VALUE_0).toBe('<redacted>');
  });
});

describe('parseHostFromGitUrl', () => {
  // Per-host scoping is the whole reason this helper exists: a token bound to
  // github.acme.corp must not be sent to github.com, and vice versa. Each
  // shape git accepts as a clone URL needs to round-trip to the right host.
  it('extracts host from https URLs', () => {
    expect(parseHostFromGitUrl('https://github.com/foo/bar.git')).toBe('github.com');
    expect(parseHostFromGitUrl('https://github.com/foo/bar')).toBe('github.com');
    expect(parseHostFromGitUrl('http://gitlab.example.com/foo/bar.git')).toBe('gitlab.example.com');
  });

  it('strips userinfo from https URLs (e.g. legacy x-access-token: prefix)', () => {
    // Defence-in-depth: even if a stale URL still has userinfo splicing, we
    // must scope the header to the host, not to "user@host".
    expect(parseHostFromGitUrl('https://x-access-token:ghp_xxx@github.com/foo/bar.git')).toBe(
      'github.com'
    );
  });

  it('strips ports from https URLs', () => {
    // GitHub Enterprise is sometimes deployed on a non-default port.
    expect(parseHostFromGitUrl('https://github.acme.corp:8443/foo/bar.git')).toBe(
      'github.acme.corp'
    );
  });

  it('extracts host from ssh:// URLs', () => {
    expect(parseHostFromGitUrl('ssh://git@github.com/foo/bar.git')).toBe('github.com');
    expect(parseHostFromGitUrl('ssh://git@github.com:22/foo/bar.git')).toBe('github.com');
    expect(parseHostFromGitUrl('ssh://github.com/foo/bar')).toBe('github.com');
  });

  it('extracts host from SCP-like URLs (git@host:path)', () => {
    expect(parseHostFromGitUrl('git@github.com:foo/bar.git')).toBe('github.com');
    expect(parseHostFromGitUrl('git@github.acme.corp:foo/bar')).toBe('github.acme.corp');
  });

  it('returns undefined for local paths (no remote host)', () => {
    // A local path has no host to scope to; the caller should fall back to
    // the default (which is fine — local fs operations don't use auth).
    expect(parseHostFromGitUrl('/var/repos/foo')).toBeUndefined();
    expect(parseHostFromGitUrl('./foo/bar')).toBeUndefined();
    expect(parseHostFromGitUrl('file:///var/repos/foo')).toBeUndefined();
  });

  it('returns undefined for malformed input', () => {
    expect(parseHostFromGitUrl('')).toBeUndefined();
    expect(parseHostFromGitUrl('not a url')).toBeUndefined();
    // Defensive against non-string inputs slipping through type erosion at
    // module boundaries (e.g. JSON config). Cast is only to satisfy the test.
    expect(parseHostFromGitUrl(undefined as unknown as string)).toBeUndefined();
    expect(parseHostFromGitUrl(null as unknown as string)).toBeUndefined();
  });
});

describe('argv-leak tripwire', () => {
  it('cloneRepo source contains no token-in-URL splicing', () => {
    // The whole point of the env-var refactor (PR #1103) is to keep tokens
    // off argv. The legacy approach interpolated the PAT into the clone URL
    // as `https://x-access-token:<PAT>@github.com/...`, which leaks via
    // `ps` / `/proc/<pid>/cmdline` for any user on the host while git is
    // running.
    //
    // Source-level tripwire: if a future commit re-introduces the URL-rewrite
    // path, this assertion fires and the author has to either pick a
    // non-argv-leaking mechanism OR explicitly delete this assertion with a
    // justification in the diff. Either way, the change becomes visible.
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/x-access-token:[^@\s]*@/);
    // Defence-in-depth: also forbid any string assembly producing
    // `<userinfo>@github.com/...` from a token variable. Coarse grep — fine
    // for it to flag false positives because the right answer is then to use
    // env-var-based auth and remove the construction.
    expect(src).not.toMatch(/`https:\/\/\$\{[^}]*token[^}]*\}@/i);
  });
});

describe('createGit() end-to-end env propagation', () => {
  // Regression test for the simple-git "spawnOptions.env silently dropped"
  // footgun fixed in 88c7b0e6: simple-git's constructor `spawnOptions` is
  // typed `Pick<SpawnOptions, 'uid' | 'gid'>` and quietly ignores any `env`
  // field — so an earlier version of createGit() *thought* it was passing
  // env vars to the spawned git, but git never received them, and clones
  // hung on the "Username for 'https://github.com':" interactive prompt.
  //
  // Unlike the spawnSync-based tests above (which only prove that *raw* git
  // honours GIT_CONFIG_*), this suite drives the real createGit() →
  // simpleGit() → spawned git path and asserts the env-injected config is
  // visible inside that spawned process. If the env path ever silently
  // breaks again, these tests fail loudly instead of waiting for prod hangs.

  // 30-char fake token shaped like a GitHub PAT — passes isLikelyGitToken's
  // /^[A-Za-z0-9_-]{20,255}$/ check so buildAuthHeaderEnv emits a real
  // header. Not a real credential.
  const FAKE_TOKEN = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAA';

  function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const repoPath = mkdtempSync(join(tmpdir(), 'agor-git-env-it-'));
    const init = spawnSync('git', ['init', '-q', repoPath], { stdio: 'pipe' });
    if (init.status !== 0) {
      rmSync(repoPath, { recursive: true, force: true });
      throw new Error(`git init failed: ${init.stderr?.toString()}`);
    }
    return fn(repoPath).finally(() => {
      rmSync(repoPath, { recursive: true, force: true });
    });
  }

  it('makes http.<host>.extraheader readable from the spawned git child (default github.com host)', async () => {
    await withTempRepo(async (repoPath) => {
      const { git } = createGit(repoPath, { GITHUB_TOKEN: FAKE_TOKEN });

      // `git config --get` reads from the merged config view, which includes
      // the GIT_CONFIG_COUNT/KEY_n/VALUE_n env vars. If createGit() failed
      // to push those vars into the child, this returns empty.
      const value = (
        await git.raw(['config', '--get', 'http.https://github.com/.extraheader'])
      ).trim();

      const expectedB64 = Buffer.from(`x-access-token:${FAKE_TOKEN}`, 'utf8').toString('base64');
      expect(value).toBe(`Authorization: Basic ${expectedB64}`);
    });
  });

  it('honours an explicit authHost arg (GitHub Enterprise scoping)', async () => {
    await withTempRepo(async (repoPath) => {
      const { git } = createGit(repoPath, { GITHUB_TOKEN: FAKE_TOKEN }, 'github.acme.corp');

      // The header lands on the enterprise host…
      const enterprise = (
        await git.raw(['config', '--get', 'http.https://github.acme.corp/.extraheader'])
      ).trim();
      expect(enterprise).toMatch(/^Authorization: Basic /);

      // …and crucially does NOT also leak to github.com. `git config --get`
      // of a missing key exits 1; simple-git surfaces that as an empty
      // resolved value here.
      const githubCom = (
        await git.raw(['config', '--get', 'http.https://github.com/.extraheader'])
      ).trim();
      expect(githubCom).toBe('');
    });
  });

  it('does not set any extraheader when no token is supplied', async () => {
    await withTempRepo(async (repoPath) => {
      // Pass an env (so the isolation block activates) but no token. The
      // auth header must not appear — otherwise we'd be silently scoping a
      // header that carries no credential.
      const { git } = createGit(repoPath, { SOME_OTHER_VAR: 'x' });
      const value = (
        await git.raw(['config', '--get', 'http.https://github.com/.extraheader'])
      ).trim();
      expect(value).toBe('');
    });
  });

  it('survives ambient GIT_EDITOR in process.env (allowUnsafeEditor opt-in)', async () => {
    // Regression test: simple-git's vulnerability scanner refuses to spawn
    // git when env vars like GIT_EDITOR / GIT_PAGER / GIT_ASKPASS are set
    // unless we opt in via the `unsafe.allowUnsafe*` flags. A daemon process
    // that inherits `EDITOR=vim` (and therefore GIT_EDITOR) from a login
    // shell must still be able to clone — the scanner's refusal would
    // otherwise hang the daemon with no useful error.
    const prev = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = '/bin/false';
    try {
      await withTempRepo(async (repoPath) => {
        const { git } = createGit(repoPath, { GITHUB_TOKEN: FAKE_TOKEN });
        // Without allowUnsafeEditor, simple-git's scanner throws before spawn
        // ("Use of GIT_EDITOR is not permitted...").
        const value = (
          await git.raw(['config', '--get', 'http.https://github.com/.extraheader'])
        ).trim();
        expect(value).toMatch(/^Authorization: Basic /);
      });
    } finally {
      if (prev === undefined) delete process.env.GIT_EDITOR;
      else process.env.GIT_EDITOR = prev;
    }
  });

  it('GIT_CONFIG_GLOBAL=/dev/null isolation reaches the spawned git', async () => {
    // Sanity check the inheritance kill survives the simple-git pipeline:
    // anything in the daemon user's ~/.gitconfig must not appear via
    // `git config --global --get`.
    await withTempRepo(async (repoPath) => {
      const { git } = createGit(repoPath, { GITHUB_TOKEN: FAKE_TOKEN });
      // user.email is the canonical thing a daemon user is likely to have
      // set globally; confirm it's invisible here.
      const value = (await git.raw(['config', '--global', '--get', 'user.email'])).trim();
      expect(value).toBe('');
    });
  });
});
