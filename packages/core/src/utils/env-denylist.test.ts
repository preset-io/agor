/**
 * Tests for the env-var denylist used when forwarding caller-supplied env
 * vars (payload env, user env config) to spawned subprocesses.
 */

import { describe, expect, it } from 'vitest';
import { ENV_DENY_EXACT, filterEnv, isDeniedEnvKey } from './env-denylist';

describe('env-denylist', () => {
  describe('isDeniedEnvKey', () => {
    it('rejects Node.js process-hijacking keys', () => {
      expect(isDeniedEnvKey('NODE_OPTIONS')).toBe(true);
      expect(isDeniedEnvKey('NODE_EXTRA_CA_CERTS')).toBe(true);
    });

    it('rejects exact LD_* keys', () => {
      expect(isDeniedEnvKey('LD_PRELOAD')).toBe(true);
      expect(isDeniedEnvKey('LD_LIBRARY_PATH')).toBe(true);
      expect(isDeniedEnvKey('LD_AUDIT')).toBe(true);
      expect(isDeniedEnvKey('LD_BIND_NOW')).toBe(true);
    });

    it('rejects unknown LD_* keys via wildcard', () => {
      expect(isDeniedEnvKey('LD_SOMETHING_ELSE')).toBe(true);
      expect(isDeniedEnvKey('LD_FOO')).toBe(true);
    });

    it('rejects DYLD_* keys (macOS)', () => {
      expect(isDeniedEnvKey('DYLD_INSERT_LIBRARIES')).toBe(true);
      expect(isDeniedEnvKey('DYLD_LIBRARY_PATH')).toBe(true);
      expect(isDeniedEnvKey('DYLD_CUSTOM_VAR')).toBe(true);
    });

    it('rejects PYTHON* keys', () => {
      expect(isDeniedEnvKey('PYTHONSTARTUP')).toBe(true);
      expect(isDeniedEnvKey('PYTHONPATH')).toBe(true);
      expect(isDeniedEnvKey('PYTHONHOME')).toBe(true);
      expect(isDeniedEnvKey('PYTHONUSERBASE')).toBe(true);
      expect(isDeniedEnvKey('PYTHONEXECUTABLE')).toBe(true);
    });

    it('rejects unknown PYTHON* keys via wildcard', () => {
      expect(isDeniedEnvKey('PYTHONFAULTHANDLER')).toBe(true);
      expect(isDeniedEnvKey('PYTHON_FOO')).toBe(true);
    });

    it('allows PYTHON_AGOR_* carve-out', () => {
      expect(isDeniedEnvKey('PYTHON_AGOR_MODE')).toBe(false);
      expect(isDeniedEnvKey('PYTHON_AGOR_WORKTREE')).toBe(false);
    });

    it('rejects Perl / Ruby hijacking keys', () => {
      expect(isDeniedEnvKey('PERL5LIB')).toBe(true);
      expect(isDeniedEnvKey('PERL5OPT')).toBe(true);
      expect(isDeniedEnvKey('RUBYOPT')).toBe(true);
      expect(isDeniedEnvKey('RUBYLIB')).toBe(true);
      expect(isDeniedEnvKey('GEM_PATH')).toBe(true);
    });

    it('rejects shell-init hijacking keys', () => {
      expect(isDeniedEnvKey('BASH_ENV')).toBe(true);
      expect(isDeniedEnvKey('ENV')).toBe(true);
    });

    it('rejects PATH override', () => {
      expect(isDeniedEnvKey('PATH')).toBe(true);
    });

    it('passes through unrelated keys', () => {
      expect(isDeniedEnvKey('MY_APP_VAR')).toBe(false);
      expect(isDeniedEnvKey('GITHUB_TOKEN')).toBe(false);
      expect(isDeniedEnvKey('HOME')).toBe(false);
      expect(isDeniedEnvKey('USER')).toBe(false);
      expect(isDeniedEnvKey('DAEMON_URL')).toBe(false);
    });
  });

  describe('filterEnv', () => {
    it('strips denied keys and keeps the rest', () => {
      const { env, rejected } = filterEnv({
        NODE_OPTIONS: '--require=/tmp/x.js',
        LD_PRELOAD: '/tmp/evil.so',
        PYTHONSTARTUP: '/tmp/rce.py',
        LD_SOMETHING_ELSE: 'bad',
        MY_APP_VAR: 'keep me',
        GITHUB_TOKEN: 'ghp_abc123',
      });

      expect(env).toEqual({
        MY_APP_VAR: 'keep me',
        GITHUB_TOKEN: 'ghp_abc123',
      });
      expect(rejected).toEqual(
        expect.arrayContaining(['NODE_OPTIONS', 'LD_PRELOAD', 'PYTHONSTARTUP', 'LD_SOMETHING_ELSE'])
      );
      expect(rejected).toHaveLength(4);
    });

    it('returns empty result for undefined/null env', () => {
      expect(filterEnv(undefined)).toEqual({ env: {}, rejected: [] });
    });

    it('skips undefined values', () => {
      const { env, rejected } = filterEnv({
        DEFINED: 'yes',
        UNDEFINED: undefined,
      });
      expect(env).toEqual({ DEFINED: 'yes' });
      expect(rejected).toEqual([]);
    });

    it('invokes onReject callback for each rejection', () => {
      const rejected: string[] = [];
      filterEnv({ NODE_OPTIONS: '--evil', GOOD: 'ok', LD_PRELOAD: 'x' }, (key) =>
        rejected.push(key)
      );
      expect(rejected.sort()).toEqual(['LD_PRELOAD', 'NODE_OPTIONS']);
    });

    it('exposes the exact-match list for audit', () => {
      expect(ENV_DENY_EXACT).toContain('NODE_OPTIONS');
      expect(ENV_DENY_EXACT).toContain('LD_PRELOAD');
      expect(ENV_DENY_EXACT).toContain('PYTHONSTARTUP');
      expect(ENV_DENY_EXACT).toContain('PATH');
    });
  });
});
