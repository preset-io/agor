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
      it('wraps with sudo su -', () => {
        const result = buildSpawnArgs('whoami', [], 'alice');
        expect(result).toEqual({
          cmd: 'sudo',
          args: ['-n', 'su', '-', 'alice', '-c', 'whoami'],
        });
      });

      it('escapes command args', () => {
        const result = buildSpawnArgs('zellij', ['attach', 'my session'], 'alice');
        expect(result).toEqual({
          cmd: 'sudo',
          args: ['-n', 'su', '-', 'alice', '-c', "zellij 'attach' 'my session'"],
        });
      });
    });

    describe('with impersonation (options object)', () => {
      it('wraps with sudo su - when asUser provided', () => {
        const result = buildSpawnArgs('whoami', [], { asUser: 'bob' });
        expect(result).toEqual({
          cmd: 'sudo',
          args: ['-n', 'su', '-', 'bob', '-c', 'whoami'],
        });
      });

      it('returns unchanged when asUser not provided', () => {
        const result = buildSpawnArgs('whoami', [], {});
        expect(result).toEqual({
          cmd: 'whoami',
          args: [],
        });
      });
    });

    describe('with env vars', () => {
      it('injects env vars into inner command when impersonating', () => {
        const result = buildSpawnArgs('node', ['script.js'], {
          asUser: 'alice',
          env: { GITHUB_TOKEN: 'abc123', NODE_ENV: 'test' },
        });
        expect(result.cmd).toBe('sudo');
        expect(result.args[0]).toBe('-n');
        expect(result.args[1]).toBe('su');
        expect(result.args[2]).toBe('-');
        expect(result.args[3]).toBe('alice');
        expect(result.args[4]).toBe('-c');
        // Inner command should have env prefix
        expect(result.args[5]).toContain('env ');
        expect(result.args[5]).toContain("GITHUB_TOKEN='abc123'");
        expect(result.args[5]).toContain("NODE_ENV='test'");
        expect(result.args[5]).toContain("node 'script.js'");
      });

      it('escapes env var values with special characters', () => {
        const result = buildSpawnArgs('node', [], {
          asUser: 'alice',
          env: { SECRET: "pass'word" },
        });
        // Should escape the single quote in the value
        expect(result.args[5]).toContain("SECRET='pass'\\''word'");
      });

      it('ignores env vars when not impersonating', () => {
        const result = buildSpawnArgs('node', ['script.js'], {
          env: { GITHUB_TOKEN: 'abc123' },
        });
        // Without asUser, env should not affect the output
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
  });
});
