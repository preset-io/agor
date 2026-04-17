import { describe, expect, it } from 'vitest';
import {
  buildSpawnArgs,
  escapeShellArg,
  isSecretEnvKey,
  redactSecretEnv,
  SECRET_ENV_KEY_PATTERN,
} from './run-as-user.js';

describe('run-as-user', () => {
  describe('escapeShellArg', () => {
    it('wraps simple strings in single quotes', () => {
      expect(escapeShellArg('hello')).toBe("'hello'");
    });

    it('escapes single quotes within the string', () => {
      expect(escapeShellArg("hello'world")).toBe("'hello'\\''world'");
    });

    it('handles empty strings', () => {
      expect(escapeShellArg('')).toBe("''");
    });

    it('handles strings with spaces', () => {
      expect(escapeShellArg('hello world')).toBe("'hello world'");
    });

    it('handles strings with special characters', () => {
      expect(escapeShellArg('$HOME')).toBe("'$HOME'");
      expect(escapeShellArg('a && b')).toBe("'a && b'");
    });
  });

  describe('buildSpawnArgs', () => {
    describe('without impersonation', () => {
      it('returns command and args unchanged', () => {
        const result = buildSpawnArgs('node', ['script.js', '--flag']);
        expect(result).toEqual({
          cmd: 'node',
          args: ['script.js', '--flag'],
        });
      });

      it('handles empty args', () => {
        const result = buildSpawnArgs('whoami');
        expect(result).toEqual({
          cmd: 'whoami',
          args: [],
        });
      });
    });

    describe('with impersonation (string asUser - backward compat)', () => {
      it('wraps with sudo -u bash -c', () => {
        const result = buildSpawnArgs('whoami', [], 'alice');
        expect(result).toEqual({
          cmd: 'sudo',
          args: ['-n', '-u', 'alice', 'bash', '-c', 'whoami'],
        });
      });

      it('escapes command args', () => {
        const result = buildSpawnArgs('zellij', ['attach', 'my session'], 'alice');
        expect(result).toEqual({
          cmd: 'sudo',
          args: ['-n', '-u', 'alice', 'bash', '-c', "zellij 'attach' 'my session'"],
        });
      });
    });

    describe('with impersonation (options object)', () => {
      it('wraps with sudo -u when asUser provided', () => {
        const result = buildSpawnArgs('whoami', [], { asUser: 'bob' });
        expect(result).toEqual({
          cmd: 'sudo',
          args: ['-n', '-u', 'bob', 'bash', '-c', 'whoami'],
        });
      });

      it('returns unchanged when asUser not provided', () => {
        const result = buildSpawnArgs('whoami', [], {});
        expect(result).toEqual({
          cmd: 'whoami',
          args: [],
        });
      });

      it('rejects invalid asUser (shell metacharacters)', () => {
        expect(() => buildSpawnArgs('whoami', [], { asUser: 'alice; rm -rf /' })).toThrow(
          /invalid Unix username/
        );
        expect(() => buildSpawnArgs('whoami', [], { asUser: '-oRemoteForward=...' })).toThrow(
          /invalid Unix username/
        );
      });
    });

    describe('with env vars (legacy inline path)', () => {
      it('injects env vars into inner command when impersonating', () => {
        const result = buildSpawnArgs('node', ['script.js'], {
          asUser: 'alice',
          env: { DAEMON_URL: 'http://localhost:3030', NODE_ENV: 'test' },
        });
        expect(result.cmd).toBe('sudo');
        expect(result.args[0]).toBe('-n');
        expect(result.args[1]).toBe('-u');
        expect(result.args[2]).toBe('alice');
        expect(result.args[3]).toBe('bash');
        expect(result.args[4]).toBe('-c');
        // Inner command should have env prefix
        expect(result.args[5]).toContain('env ');
        expect(result.args[5]).toContain("DAEMON_URL='http://localhost:3030'");
        expect(result.args[5]).toContain("NODE_ENV='test'");
        expect(result.args[5]).toContain("node 'script.js'");
      });

      it('ignores env vars when not impersonating', () => {
        const result = buildSpawnArgs('node', ['script.js'], {
          env: { NODE_ENV: 'test' },
        });
        expect(result).toEqual({
          cmd: 'node',
          args: ['script.js'],
        });
      });

      it('handles empty env object', () => {
        const result = buildSpawnArgs('node', [], {
          asUser: 'alice',
          env: {},
        });
        // Should not have env prefix
        expect(result.args[5]).toBe('node');
      });
    });

    describe('with envFilePath (secure path)', () => {
      it('uses envFilePath to source env inside impersonated shell', () => {
        const result = buildSpawnArgs('node', ['script.js'], {
          asUser: 'alice',
          envFilePath: '/tmp/agor-env-abc123',
        });
        expect(result.cmd).toBe('sudo');
        expect(result.args.slice(0, 4)).toEqual(['-n', '-u', 'alice', 'bash']);
        expect(result.args[4]).toBe('-c');
        // Script references ENVFILE from $1, not interpolated
        expect(result.args[5]).toBe(
          'ENVFILE="$1"; shift; set -a; . "$ENVFILE"; set +a; rm -f "$ENVFILE"; exec "$@"'
        );
        // Positional args: separator, envFilePath, then the real command
        expect(result.args[6]).toBe('--');
        expect(result.args[7]).toBe('/tmp/agor-env-abc123');
        expect(result.args[8]).toBe('node');
        expect(result.args[9]).toBe('script.js');
      });

      it('REGRESSION: does NOT contain any secret values in argv', () => {
        const secretValues = {
          ANTHROPIC_API_KEY: 'sk-ant-super-secret-value-DO-NOT-LEAK',
          OPENAI_API_KEY: 'sk-openai-super-secret-value-DO-NOT-LEAK',
          GEMINI_API_KEY: 'gemini-super-secret-value-DO-NOT-LEAK',
          GITHUB_TOKEN: 'ghp_super-secret-token-DO-NOT-LEAK',
          OAUTH_REFRESH_TOKEN: 'oauth-super-secret-refresh-DO-NOT-LEAK',
          SOMETHING_SECRET: 'some-super-secret-DO-NOT-LEAK',
        };
        // Using the secure path: envFilePath + no inline env
        const result = buildSpawnArgs('node', ['executor', '--stdin'], {
          asUser: 'alice',
          envFilePath: '/tmp/agor-env-nonce',
        });

        const argvSerialized = [result.cmd, ...result.args].join('\n');
        for (const value of Object.values(secretValues)) {
          expect(argvSerialized).not.toContain(value);
        }
      });

      it('rejects envFilePath containing shell metacharacters', () => {
        expect(() =>
          buildSpawnArgs('node', [], {
            asUser: 'alice',
            envFilePath: '/tmp/evil; rm -rf /',
          })
        ).toThrow(/suspicious envFilePath/);
        expect(() =>
          buildSpawnArgs('node', [], {
            asUser: 'alice',
            envFilePath: '/tmp/evil`whoami`',
          })
        ).toThrow(/suspicious envFilePath/);
      });
    });
  });

  describe('isSecretEnvKey / SECRET_ENV_KEY_PATTERN', () => {
    it('matches *_API_KEY', () => {
      expect(isSecretEnvKey('ANTHROPIC_API_KEY')).toBe(true);
      expect(isSecretEnvKey('OPENAI_API_KEY')).toBe(true);
      expect(isSecretEnvKey('GEMINI_API_KEY')).toBe(true);
      expect(isSecretEnvKey('GOOGLE_API_KEY')).toBe(true);
    });

    it('matches *_TOKEN', () => {
      expect(isSecretEnvKey('GITHUB_TOKEN')).toBe(true);
      expect(isSecretEnvKey('ANTHROPIC_AUTH_TOKEN')).toBe(true);
    });

    it('matches *_SECRET', () => {
      expect(isSecretEnvKey('JWT_SECRET')).toBe(true);
      expect(isSecretEnvKey('CLIENT_SECRET')).toBe(true);
    });

    it('matches OAUTH_* prefix', () => {
      expect(isSecretEnvKey('OAUTH_ACCESS_TOKEN')).toBe(true);
      expect(isSecretEnvKey('OAUTH_REFRESH_TOKEN')).toBe(true);
    });

    it('does not match non-secret names', () => {
      expect(isSecretEnvKey('PATH')).toBe(false);
      expect(isSecretEnvKey('HOME')).toBe(false);
      expect(isSecretEnvKey('NODE_ENV')).toBe(false);
      expect(isSecretEnvKey('DAEMON_URL')).toBe(false);
      expect(isSecretEnvKey('TERM')).toBe(false);
    });

    it('pattern is exported for caller use', () => {
      expect(SECRET_ENV_KEY_PATTERN).toBeInstanceOf(RegExp);
    });
  });

  describe('redactSecretEnv', () => {
    it('drops secret keys by default', () => {
      const input = {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-leak',
        GITHUB_TOKEN: 'ghp-leak',
      };
      const out = redactSecretEnv(input);
      expect(out).toEqual({ PATH: '/usr/bin' });
      // Values never appear
      expect(JSON.stringify(out)).not.toContain('sk-ant-leak');
      expect(JSON.stringify(out)).not.toContain('ghp-leak');
    });

    it('with keepKeys=true, redacts values but keeps keys', () => {
      const out = redactSecretEnv(
        { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-leak' },
        { keepKeys: true }
      );
      expect(out).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: '***' });
      expect(JSON.stringify(out)).not.toContain('sk-ant-leak');
    });

    it('drops undefined values', () => {
      const out = redactSecretEnv({ PATH: '/usr/bin', MAYBE: undefined });
      expect(out).toEqual({ PATH: '/usr/bin' });
    });
  });
});
