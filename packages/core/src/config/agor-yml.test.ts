/**
 * Tests for .agor.yml parser/writer (v2 named variants).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RepoEnvironment, RepoEnvironmentConfigV1 } from '../types/branch';
import { parseAgorYml, resolveVariant, writeAgorYml } from './agor-yml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const REPO_ROOT_AGOR_YML = path.join(REPO_ROOT, '.agor.yml');

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
  health: "http://localhost:{{add 9000 branch.unique_id}}/health"
  app: "http://localhost:{{add 5000 branch.unique_id}}"
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
            health: 'http://localhost:{{add 9000 branch.unique_id}}/health',
            app: 'http://localhost:{{add 5000 branch.unique_id}}',
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

describe('parseAgorYml — repo .agor.yml demo variants', () => {
  it('keeps the Codespaces provider opt-in and wires exact revision Sync', () => {
    const env = parseAgorYml(REPO_ROOT_AGOR_YML);
    expect(env).not.toBeNull();
    expect(env!.default).toBe('sqlite');

    const codespaces = resolveVariant(env!, 'codespaces-sqlite');
    if (codespaces === null) throw new Error('codespaces-sqlite variant must resolve');

    expect(codespaces.startup_timeout_ms).toBe(1_500_000);
    expect(codespaces.start).toMatch(/agor-codespace-launcher\.mjs start/);
    expect(codespaces.start).toContain('--wait-seconds 1440');
    expect(codespaces.start).toContain('--repository {{shellQuote repo.github_slug}}');
    expect(codespaces.start).toContain('--port-visibility public');
    expect(codespaces.sync).toMatch(/agor-codespace-launcher\.mjs sync/);
    expect(codespaces.sync).toContain('--revision {{shellQuote sync.revision}}');
    expect(codespaces.stop).toMatch(/agor-codespace-launcher\.mjs stop/);
    expect(codespaces.stop).toContain('--wait-seconds 1200');
    expect(codespaces.nuke).toMatch(/agor-codespace-launcher\.mjs nuke/);
    expect(codespaces.nuke).toContain('--wait-seconds 1200');
    expect(codespaces.logs).toMatch(/agor-codespace-launcher\.mjs logs/);
    // Start publishes the actual dynamic app/health URLs in its typed result.
    expect(codespaces.health).toBeUndefined();
    expect(codespaces.app).toBe('https://github.com/codespaces');
  });

  it('renders HA as the auth-resolved multi-tenant development profile', () => {
    const env = parseAgorYml(REPO_ROOT_AGOR_YML);
    expect(env).not.toBeNull();
    const ha = resolveVariant(env!, 'ha');
    if (ha === null) throw new Error('ha variant must resolve');

    expect(ha.start).toContain('AGOR_EXTERNAL_LAUNCH_SHARED_SECRET=');
    expect(ha.start).not.toContain('AGOR_ADMIN_PASSWORD=');
    expect(ha.app).toMatch(/\/dev-auth\/$/);
    expect(ha.description).toMatch(/auth-resolved tenants/);
  });

  it('forwards the RBAC fixture flag used by .env.postgres', () => {
    const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/- CREATE_RBAC_TEST_USERS=\$\{CREATE_RBAC_TEST_USERS:-\}/);
  });

  it('makes branch SDK homes the rich/full RBAC fixture default', () => {
    const baseCompose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
    const richOverlay = fs.readFileSync(
      path.join(REPO_ROOT, 'docker-compose.postgres.yml'),
      'utf8'
    );
    expect(baseCompose).toMatch(/AGOR_SANDBOX_SDK_HOME_MODE=\$\{AGOR_SANDBOX_SDK_HOME_MODE:-\}/);
    expect(richOverlay).toMatch(
      /AGOR_SANDBOX_SDK_HOME_MODE=\$\{AGOR_SANDBOX_SDK_HOME_MODE:-per_branch\}/
    );
  });

  it('keeps persisted deployment secrets stable when switching postgres variants', () => {
    const env = parseAgorYml(REPO_ROOT_AGOR_YML);
    expect(env).not.toBeNull();

    const postgres = resolveVariant(env!, 'postgres');
    const rich = resolveVariant(env!, 'rich');
    if (postgres === null || rich === null) throw new Error('postgres/rich variants must resolve');

    // Both variants use the same Compose project and project-scoped agor-home
    // volume. Neither command nor overlay may replace its persisted secrets.
    for (const variant of [postgres, rich]) {
      expect(variant.start).toContain('-p agor-{{branch.name}}');
      expect(variant.start).not.toMatch(/AGOR_(JWT|MASTER)_SECRET/);
    }
    for (const overlay of ['docker-compose.override.postgres.yml', 'docker-compose.postgres.yml']) {
      expect(fs.readFileSync(path.join(REPO_ROOT, overlay), 'utf8')).not.toMatch(
        /AGOR_(JWT|MASTER)_SECRET/
      );
    }
  });

  it('uses env(1) for UID/GID on Docker variants instead of shell assignments', () => {
    const env = parseAgorYml(REPO_ROOT_AGOR_YML);
    expect(env).not.toBeNull();

    const uidGidVariants = Object.entries(env!.variants)
      .filter(([, variant]) => {
        const start = variant.start;
        return start !== undefined && (start.includes('UID=') || start.includes('GID='));
      })
      .map(([name]) => name)
      .sort();

    expect(uidGidVariants).toEqual([
      'postgres',
      'postgres-demo',
      'rich',
      'sandbox',
      'sandbox-peruser',
      'sqlite',
      'sqlite-demo',
    ]);

    for (const name of uidGidVariants) {
      const start = env!.variants[name].start;
      if (start === undefined) {
        throw new Error(`${name}.start is missing`);
      }
      expect(start, `${name}.start`).toMatch(/^env UID=\$\(id -u\) GID=/);
      expect(start, `${name}.start`).not.toMatch(/^UID=/);
    }
  });

  it('keeps full as a deprecated compatibility alias for rich', () => {
    const env = parseAgorYml(REPO_ROOT_AGOR_YML);
    expect(env).not.toBeNull();

    expect(env!.variants.full.extends).toBe('rich');
    expect(env!.variants.full.description).toMatch(/Deprecated compatibility alias/);

    const rich = resolveVariant(env!, 'rich');
    const full = resolveVariant(env!, 'full');
    if (rich === null || full === null) throw new Error('rich/full variants must resolve');
    expect(full).toMatchObject({
      start: rich.start,
      stop: rich.stop,
      nuke: rich.nuke,
      logs: rich.logs,
      health: rich.health,
      app: rich.app,
    });
  });

  it('resolves sqlite-demo / postgres-demo with LOAD_FIXTURES and required start/stop', () => {
    const env = parseAgorYml(REPO_ROOT_AGOR_YML);
    expect(env).not.toBeNull();
    // Additive only — the default stays sqlite.
    expect(env?.default).toBe('sqlite');

    for (const name of ['sqlite-demo', 'postgres-demo']) {
      const resolved = resolveVariant(env!, name);
      expect(resolved, `${name} resolves`).not.toBeNull();
      expect(resolved!.start, `${name}.start`).toMatch(/SEED=true LOAD_FIXTURES=true/);
      expect(resolved!.stop, `${name}.stop`).toBeTruthy();
      // extends: sqlite is resolved away.
      expect(
        (resolved as RepoEnvironment['variants'][string] & { extends?: string }).extends
      ).toBeUndefined();
    }

    // The demo variants differ from their siblings by exactly LOAD_FIXTURES=true.
    const withFixtures = (start: string | undefined) =>
      start?.replace('SEED=true', 'SEED=true LOAD_FIXTURES=true');
    expect(resolveVariant(env!, 'sqlite-demo')!.start).toBe(
      withFixtures(resolveVariant(env!, 'sqlite')!.start)
    );
    expect(resolveVariant(env!, 'postgres-demo')!.start).toBe(
      withFixtures(resolveVariant(env!, 'postgres')!.start)
    );
  });

  it('explicitly acknowledges offline cutovers only for isolated managed dev variants', () => {
    const env = parseAgorYml(REPO_ROOT_AGOR_YML);
    expect(env).not.toBeNull();

    for (const name of [
      'rich',
      'full',
      'sqlite',
      'sandbox',
      'sandbox-peruser',
      'postgres',
      'sqlite-demo',
      'postgres-demo',
    ]) {
      expect(resolveVariant(env!, name)?.start, `${name}.start`).toContain(
        'AGOR_MIGRATION_OFFLINE_CUTOVER=true'
      );
    }

    // HA has its own one-shot migrator and must not leak this standalone
    // development acknowledgement into daemon replicas.
    expect(resolveVariant(env!, 'ha')?.start).not.toContain('AGOR_MIGRATION_OFFLINE_CUTOVER=true');
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
            startup_timeout_ms: 2_700_000,
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
