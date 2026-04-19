/**
 * Tests for .agor.yml parser/writer (v2 named variants).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoEnvironment, RepoEnvironmentConfigV1 } from '../types/worktree';
import { parseAgorYml, resolveVariant, writeAgorYml } from './agor-yml';

function withTmpFile<T>(fn: (filePath: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-yml-test-'));
  const filePath = path.join(tmpDir, '.agor.yml');
  try {
    return fn(filePath);
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    fs.rmdirSync(tmpDir);
  }
}

describe('parseAgorYml — v1 legacy (flat) form', () => {
  it('wraps flat form as a single `default` variant', () => {
    withTmpFile((file) => {
      fs.writeFileSync(
        file,
        `environment:
  start: "docker compose up -d"
  stop: "docker compose down"
  health: "http://localhost:{{add 9000 worktree.unique_id}}/health"
  app: "http://localhost:{{add 5000 worktree.unique_id}}"
  logs: "docker compose logs --tail=100"
  nuke: "docker compose down -v"`
      );

      const env = parseAgorYml(file);
      expect(env).toEqual<RepoEnvironment>({
        version: 2,
        default: 'default',
        variants: {
          default: {
            start: 'docker compose up -d',
            stop: 'docker compose down',
            nuke: 'docker compose down -v',
            health: 'http://localhost:{{add 9000 worktree.unique_id}}/health',
            app: 'http://localhost:{{add 5000 worktree.unique_id}}',
            logs: 'docker compose logs --tail=100',
          },
        },
      });
    });
  });

  it('v1 with only required fields still wraps correctly', () => {
    withTmpFile((file) => {
      fs.writeFileSync(file, `environment:\n  start: "pnpm dev"\n  stop: "pkill pnpm"\n`);
      const env = parseAgorYml(file);
      expect(env?.default).toBe('default');
      expect(env?.variants.default).toEqual({ start: 'pnpm dev', stop: 'pkill pnpm' });
    });
  });

  it('throws if v1 flat form is missing start/stop', () => {
    withTmpFile((file) => {
      fs.writeFileSync(file, `environment:\n  stop: "docker compose down"\n`);
      expect(() => parseAgorYml(file)).toThrow(/"start" and "stop"/);
    });
  });
});

describe('parseAgorYml — v2 variants form', () => {
  it('parses v2 with multiple variants and a default', () => {
    withTmpFile((file) => {
      fs.writeFileSync(
        file,
        `environment:
  default: dev
  variants:
    dev:
      description: "Run the dev stack"
      start: "pnpm dev"
      stop: "pkill -f pnpm"
    e2e:
      start: "pnpm e2e"
      stop: "pnpm e2e:stop"
      health: "http://localhost:4000/health"`
      );

      const env = parseAgorYml(file);
      expect(env?.version).toBe(2);
      expect(env?.default).toBe('dev');
      expect(Object.keys(env!.variants).sort()).toEqual(['dev', 'e2e']);
      expect(env?.variants.dev.description).toBe('Run the dev stack');
      expect(env?.variants.e2e.health).toBe('http://localhost:4000/health');
    });
  });

  it('throws if default references a missing variant', () => {
    withTmpFile((file) => {
      fs.writeFileSync(
        file,
        `environment:
  default: ghost
  variants:
    dev:
      start: "pnpm dev"
      stop: "pkill pnpm"`
      );
      expect(() => parseAgorYml(file)).toThrow(/default variant "ghost"/);
    });
  });

  it('throws if a variant is missing required start/stop', () => {
    withTmpFile((file) => {
      fs.writeFileSync(
        file,
        `environment:
  default: dev
  variants:
    dev:
      stop: "pkill"`
      );
      expect(() => parseAgorYml(file)).toThrow(/"start"/);
    });
  });
});

describe('parseAgorYml — extends validation', () => {
  it('accepts single-level extends', () => {
    withTmpFile((file) => {
      fs.writeFileSync(
        file,
        `environment:
  default: dev
  variants:
    base:
      start: "pnpm dev"
      stop: "pkill pnpm"
      health: "http://localhost:3000/health"
    dev:
      extends: base
      health: "http://localhost:3001/health"`
      );
      const env = parseAgorYml(file)!;
      const resolved = resolveVariant(env, 'dev');
      expect(resolved).toEqual({
        start: 'pnpm dev',
        stop: 'pkill pnpm',
        health: 'http://localhost:3001/health',
      });
      expect(
        (resolved as RepoEnvironment['variants'][string] & { extends?: string }).extends
      ).toBeUndefined();
    });
  });

  it('rejects multi-level extends (chain)', () => {
    withTmpFile((file) => {
      fs.writeFileSync(
        file,
        `environment:
  default: child
  variants:
    base:
      start: "x"
      stop: "y"
    mid:
      extends: base
      start: "x"
      stop: "y"
    child:
      extends: mid
      start: "x"
      stop: "y"`
      );
      expect(() => parseAgorYml(file)).toThrow(/single-level extends/);
    });
  });

  it('rejects extends of an unknown variant', () => {
    withTmpFile((file) => {
      fs.writeFileSync(
        file,
        `environment:
  default: dev
  variants:
    dev:
      extends: ghost
      start: "x"
      stop: "y"`
      );
      expect(() => parseAgorYml(file)).toThrow(/unknown variant "ghost"/);
    });
  });

  it('rejects self-extends', () => {
    withTmpFile((file) => {
      fs.writeFileSync(
        file,
        `environment:
  default: dev
  variants:
    dev:
      extends: dev
      start: "x"
      stop: "y"`
      );
      expect(() => parseAgorYml(file)).toThrow(/cannot extend itself/);
    });
  });
});

describe('parseAgorYml — template_overrides guards', () => {
  it('rejects top-level template_overrides', () => {
    withTmpFile((file) => {
      fs.writeFileSync(
        file,
        `environment:
  start: "x"
  stop: "y"
template_overrides:
  foo: bar`
      );
      expect(() => parseAgorYml(file)).toThrow(/template_overrides/);
    });
  });

  it('rejects environment.template_overrides', () => {
    withTmpFile((file) => {
      fs.writeFileSync(
        file,
        `environment:
  start: "x"
  stop: "y"
  template_overrides:
    foo: bar`
      );
      expect(() => parseAgorYml(file)).toThrow(/template_overrides/);
    });
  });
});

describe('parseAgorYml — misc', () => {
  it('returns null if file does not exist', () => {
    expect(parseAgorYml('/nonexistent/.agor.yml')).toBeNull();
  });

  it('returns null if no environment section', () => {
    withTmpFile((file) => {
      fs.writeFileSync(file, `other:\n  field: "value"\n`);
      expect(parseAgorYml(file)).toBeNull();
    });
  });

  it('throws on invalid YAML', () => {
    withTmpFile((file) => {
      fs.writeFileSync(file, `invalid: yaml: syntax:`);
      expect(() => parseAgorYml(file)).toThrow(/Invalid YAML/);
    });
  });
});

describe('writeAgorYml', () => {
  it('writes v2 variants and round-trips cleanly', () => {
    withTmpFile((file) => {
      const env: RepoEnvironment = {
        version: 2,
        default: 'dev',
        variants: {
          dev: {
            description: 'Development',
            start: 'pnpm dev',
            stop: 'pkill pnpm',
            health: 'http://localhost:3000/health',
          },
          e2e: {
            extends: 'dev',
            start: 'pnpm e2e',
            stop: 'pnpm e2e:stop',
          },
        },
      };
      writeAgorYml(file, env);
      const parsed = parseAgorYml(file);
      expect(parsed).toEqual(env);
    });
  });

  it('accepts a v1 config and writes it as variants.default', () => {
    withTmpFile((file) => {
      const v1: RepoEnvironmentConfigV1 = {
        up_command: 'pnpm dev',
        down_command: 'pkill pnpm',
        nuke_command: 'pnpm nuke',
      };
      writeAgorYml(file, v1);
      const parsed = parseAgorYml(file);
      expect(parsed?.default).toBe('default');
      expect(parsed?.variants.default).toEqual({
        start: 'pnpm dev',
        stop: 'pkill pnpm',
        nuke: 'pnpm nuke',
      });
    });
  });

  it('strips template_overrides from output', () => {
    withTmpFile((file) => {
      const env: RepoEnvironment = {
        version: 2,
        default: 'dev',
        variants: { dev: { start: 'x', stop: 'y' } },
        template_overrides: { secret: 'should-not-appear' },
      };
      writeAgorYml(file, env);
      const text = fs.readFileSync(file, 'utf-8');
      expect(text).not.toMatch(/template_overrides/);
      expect(text).not.toMatch(/should-not-appear/);
    });
  });
});
