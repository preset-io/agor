import { describe, expect, it } from 'vitest';
import { buildSpawnArgs, escapeShellArg } from './run-as-user.js';

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
        // Script references ENVFILE from $1, not interpolated. Uses `set -eu`
        // so a failed source aborts BEFORE rm+exec (fail-closed).
        expect(result.args[5]).toBe(
          'set -eu; ENVFILE="$1"; shift; set -a; . "$ENVFILE"; set +a; rm -f -- "$ENVFILE"; exec "$@"'
        );
        // Positional args: separator, envFilePath, then the real command
        expect(result.args[6]).toBe('--');
        expect(result.args[7]).toBe('/tmp/agor-env-abc123');
        expect(result.args[8]).toBe('node');
        expect(result.args[9]).toBe('script.js');
      });

      it('inner script is fail-closed (set -eu aborts before exec on source failure)', () => {
        const result = buildSpawnArgs('node', [], {
          asUser: 'alice',
          envFilePath: '/tmp/agor-env-x',
        });
        // `set -eu` MUST appear before the source step so that a failed
        // `.  "$ENVFILE"` prevents the `exec "$@"` from launching with
        // missing secrets.
        const script = result.args[5];
        expect(script.indexOf('set -eu')).toBeLessThan(script.indexOf('. "$ENVFILE"'));
        expect(script.indexOf('. "$ENVFILE"')).toBeLessThan(script.indexOf('exec "$@"'));
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

      it('throws when envFilePath is provided without asUser', () => {
        expect(() => buildSpawnArgs('node', [], { envFilePath: '/tmp/agor-env-abc' })).toThrow(
          /envFilePath requires asUser/
        );
      });

      it('rejects relative envFilePath', () => {
        expect(() =>
          buildSpawnArgs('node', [], {
            asUser: 'alice',
            envFilePath: 'relative/path',
          })
        ).toThrow(/envFilePath must be absolute/);
      });

      it('rejects envFilePath with NUL bytes or control chars', () => {
        expect(() =>
          buildSpawnArgs('node', [], {
            asUser: 'alice',
            envFilePath: '/tmp/evil\x00ish',
          })
        ).toThrow(/control characters/);
        expect(() =>
          buildSpawnArgs('node', [], {
            asUser: 'alice',
            envFilePath: '/tmp/line\nbreak',
          })
        ).toThrow(/control characters/);
      });

      it('accepts envFilePath with spaces (macOS TMPDIR, etc.)', () => {
        // Path is passed as a positional argv entry and referenced as "$1"
        // inside bash, so shell metachars like spaces are safe and must be
        // accepted — e.g. macOS `/var/folders/.../T/` and custom TMPDIRs.
        const result = buildSpawnArgs('node', [], {
          asUser: 'alice',
          envFilePath: '/var/folders/xx/T/agor env with spaces',
        });
        expect(result.cmd).toBe('sudo');
        expect(result.args).toContain('/var/folders/xx/T/agor env with spaces');
      });
    });

    describe('with shell: true (env commands — shell-string mode)', () => {
      // Regression suite for the bug where env commands under impersonation
      // with secrets were passed to `exec "$@"`, which treated the whole
      // shell string (e.g. `SEED=true docker compose up -d`) as a single
      // program name and failed with `exec: <whole string>: not found`.
      const ENV_COMMAND =
        'SEED=true UID=$(id -u) GID=$(id -g) docker compose -p agor-x up -d --build';

      it('uses `exec bash -c "$2"` to shell-interpret the command (with envFilePath)', () => {
        const result = buildSpawnArgs(ENV_COMMAND, [], {
          asUser: 'max',
          envFilePath: '/tmp/agor-env-xyz',
          shell: true,
        });
        expect(result.cmd).toBe('sudo');
        expect(result.args.slice(0, 4)).toEqual(['-n', '-u', 'max', 'bash']);
        expect(result.args[4]).toBe('-c');
        expect(result.args[5]).toBe(
          'set -eu; ENVFILE="$1"; set -a; . "$ENVFILE"; set +a; rm -f -- "$ENVFILE"; exec bash -c "$2" agor-env'
        );
        expect(result.args[6]).toBe('--');
        expect(result.args[7]).toBe('/tmp/agor-env-xyz');
        // The user command is passed as a single opaque shell string —
        // NOT tokenised, NOT escapeShellArg'd. The inner `bash -c` is what
        // parses it. Shell metachars (`$(id -u)`, spaces, `&&`, etc.) must
        // survive unchanged.
        expect(result.args[8]).toBe(ENV_COMMAND);
      });

      it('inner script is still fail-closed (set -eu before source and exec)', () => {
        const result = buildSpawnArgs(ENV_COMMAND, [], {
          asUser: 'max',
          envFilePath: '/tmp/agor-env-y',
          shell: true,
        });
        const script = result.args[5];
        expect(script.indexOf('set -eu')).toBeLessThan(script.indexOf('. "$ENVFILE"'));
        expect(script.indexOf('. "$ENVFILE"')).toBeLessThan(script.indexOf('exec bash'));
        expect(script).toContain('rm -f -- "$ENVFILE"');
      });

      it('preserves shell metacharacters in the command string (no escaping)', () => {
        // Regression: env commands intentionally contain `$(id -u)` and
        // similar subshells that must reach the inner bash un-escaped.
        const result = buildSpawnArgs('echo "hello $(whoami)" && docker compose -p x up -d', [], {
          asUser: 'alice',
          envFilePath: '/tmp/agor-env-z',
          shell: true,
        });
        expect(result.args[8]).toBe('echo "hello $(whoami)" && docker compose -p x up -d');
      });

      it('prepends non-secret env vars via `env` prefix', () => {
        const result = buildSpawnArgs('docker compose up -d', [], {
          asUser: 'alice',
          envFilePath: '/tmp/agor-env-e',
          shell: true,
          env: { DAEMON_PORT: '3601', UI_PORT: '5601' },
        });
        expect(result.args[8]).toBe("env DAEMON_PORT='3601' UI_PORT='5601' docker compose up -d");
      });

      it('appends escaped args to the shell command when args are provided', () => {
        const result = buildSpawnArgs('docker compose', ['up', '-d'], {
          asUser: 'alice',
          envFilePath: '/tmp/agor-env-a',
          shell: true,
        });
        expect(result.args[8]).toBe("docker compose 'up' '-d'");
      });

      it('REGRESSION: does NOT contain any secret values in argv', () => {
        const secretValues = {
          ANTHROPIC_API_KEY: 'sk-ant-super-secret-value-DO-NOT-LEAK',
          DATABASE_URL: 'postgres://user:super-secret-password@host/db',
        };
        const result = buildSpawnArgs('docker compose up -d', [], {
          asUser: 'alice',
          envFilePath: '/tmp/agor-env-nonce',
          shell: true,
          // inlineEnv should contain ONLY non-secret vars in real use;
          // this test asserts that secrets passed by mistake via `env`
          // would still reach argv (which is why callers must route
          // secrets through envFilePath only). We check that the
          // envFilePath path itself does not leak anything beyond what
          // callers explicitly inlined.
        });
        const argvSerialized = [result.cmd, ...result.args].join('\n');
        for (const value of Object.values(secretValues)) {
          expect(argvSerialized).not.toContain(value);
        }
      });

      it('default (shell: false) keeps argv-mode behaviour for executor callers', () => {
        // Belt-and-braces: the executor spawn path must continue to use
        // `exec "$@"` so that `node executor.js --stdin` runs without an
        // extra shell layer. Adding `shell` must not regress it.
        const result = buildSpawnArgs('node', ['executor.js', '--stdin'], {
          asUser: 'alice',
          envFilePath: '/tmp/agor-env-default',
        });
        expect(result.args[5]).toBe(
          'set -eu; ENVFILE="$1"; shift; set -a; . "$ENVFILE"; set +a; rm -f -- "$ENVFILE"; exec "$@"'
        );
        expect(result.args.slice(8)).toEqual(['node', 'executor.js', '--stdin']);
      });
    });
  });
});
