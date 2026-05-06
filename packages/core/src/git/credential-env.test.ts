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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildAuthHeaderEnv, buildGitConfigEnv, redactGitEnv } from './index';

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

  it('counts entries as a string (git rejects numeric values for COUNT)', () => {
    const env = buildGitConfigEnv([['a', 'b']]);
    expect(typeof env.GIT_CONFIG_COUNT).toBe('string');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
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

describe('GIT_CONFIG_* env-var integration with real git', () => {
  // End-to-end check: feed buildGitConfigEnv output into a real git invocation
  // and confirm git actually reads the config back. This is the load-bearing
  // assertion the codebase didn't previously have (per #1099 retrospective:
  // no test exercises createGit end-to-end), so a future regression in env
  // shape (e.g. wrong KEY_n / VALUE_n indexing, missing COUNT) trips here
  // instead of in prod.
  it('git config --get reads back values injected via GIT_CONFIG_*', () => {
    const env = {
      ...process.env,
      // Match the full isolation profile createGit uses, so this test is
      // representative of what spawns at runtime.
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...buildGitConfigEnv([
        ['http.https://github.com/.extraheader', 'Authorization: Basic dG9wOnNlY3JldA=='],
      ]),
    };
    const result = spawnSync('git', ['config', '--get', 'http.https://github.com/.extraheader'], {
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('Authorization: Basic dG9wOnNlY3JldA==');
  });

  it('cloneRepo source contains no token-in-URL splicing (argv leak tripwire)', () => {
    // The whole point of the env-var refactor (PR #1103) is to keep tokens
    // off argv. The legacy approach interpolated the PAT into the clone URL
    // as `https://x-access-token:<PAT>@github.com/...`, which leaks via
    // `ps` / `/proc/<pid>/cmdline` for any user on the host while git is
    // running.
    //
    // This is a source-level tripwire: if a future commit re-introduces the
    // URL-rewrite path, this assertion fires and the author has to either
    // pick a non-argv-leaking mechanism (env vars, stdin, credential helper
    // pointing at a temp file) OR explicitly delete this assertion with a
    // justification in the diff. Either way, the change becomes visible.
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/x-access-token:[^@\s]*@/);
    // Defence-in-depth: also forbid any string assembly producing
    // `<userinfo>@github.com/...` from a token variable. This is a coarser
    // grep — it's fine for it to flag false positives because the right
    // answer is then to use env-var-based auth and remove the construction.
    expect(src).not.toMatch(/`https:\/\/\$\{[^}]*token[^}]*\}@/i);
  });

  it('GIT_CONFIG_GLOBAL=/dev/null hides the daemon user gitconfig from git', () => {
    // Sanity-check the inheritance kill: with GLOBAL=/dev/null, `git config
    // --global --get user.email` finds nothing regardless of what the host's
    // ~/.gitconfig actually contains.
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    const result = spawnSync('git', ['config', '--global', '--get', 'user.email'], {
      env,
      encoding: 'utf8',
    });
    // git returns exit 1 ("not found") when the key is absent — confirms
    // global config was effectively /dev/null.
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('');
  });
});
