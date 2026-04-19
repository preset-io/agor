/**
 * Unit tests for the shared, browser-safe variant resolver / validator.
 *
 * Focus: DB-side `validateRepoEnvironment` semantics that don't go through
 * `.agor.yml` file I/O (which is already covered in `agor-yml.test.ts`). In
 * particular the subtle difference vs file import: `template_overrides` is
 * **preserved** here (it's a DB-only field) but **rejected** by the YAML
 * schema validator.
 */

import { describe, expect, it } from 'vitest';
import {
  parseAgorYmlString,
  resolveVariant,
  validateAgorYmlSchema,
  validateRepoEnvironment,
} from './variant-resolver';

describe('validateRepoEnvironment', () => {
  it('preserves template_overrides (DB-only field)', () => {
    // Regression: the UI Repo YAML editor lets admins edit the full
    // `repo.environment` object, which may carry `template_overrides`. The
    // DB-side validator must keep them intact — dropping would silently wipe
    // deployment-local overrides on save.
    const input = {
      version: 2,
      default: 'dev',
      variants: {
        dev: { start: 'pnpm dev', stop: 'pkill pnpm' },
      },
      template_overrides: {
        custom: { region: 'us-west-2' },
      },
    };
    const validated = validateRepoEnvironment(input);
    expect(validated.template_overrides).toEqual({
      custom: { region: 'us-west-2' },
    });
  });

  it('rejects non-object template_overrides', () => {
    expect(() =>
      validateRepoEnvironment({
        version: 2,
        default: 'dev',
        variants: { dev: { start: 'x', stop: 'y' } },
        template_overrides: 'not-an-object',
      })
    ).toThrow(/template_overrides.*mapping/);
  });

  it('rejects array template_overrides (must be plain-object map)', () => {
    expect(() =>
      validateRepoEnvironment({
        version: 2,
        default: 'dev',
        variants: { dev: { start: 'x', stop: 'y' } },
        template_overrides: [{ region: 'us-west-2' }],
      })
    ).toThrow(/template_overrides.*mapping/);
  });

  it('enforces required start/stop on non-extends variants', () => {
    expect(() =>
      validateRepoEnvironment({
        version: 2,
        default: 'dev',
        variants: { dev: { start: 'x' } }, // missing stop
      })
    ).toThrow(/"stop"/);
  });

  it('enforces single-level extends', () => {
    expect(() =>
      validateRepoEnvironment({
        version: 2,
        default: 'leaf',
        variants: {
          base: { start: 'a', stop: 'b' },
          mid: { extends: 'base' },
          leaf: { extends: 'mid' },
        },
      })
    ).toThrow(/single-level extends/);
  });

  it('requires default to be a defined variant', () => {
    expect(() =>
      validateRepoEnvironment({
        version: 2,
        default: 'missing',
        variants: { dev: { start: 'x', stop: 'y' } },
      })
    ).toThrow(/default.*not defined/);
  });
});

describe('validateAgorYmlSchema', () => {
  // Complement of the test above: the `.agor.yml` path MUST reject
  // `template_overrides` even though the DB path preserves it. Keeps the two
  // validators' contracts crisp and catches any future merge of the two.
  it('rejects template_overrides at root', () => {
    expect(() =>
      validateAgorYmlSchema({
        template_overrides: { foo: 1 },
        environment: { variants: { dev: { start: 'x', stop: 'y' } }, default: 'dev' },
      })
    ).toThrow(/template_overrides/);
  });

  it('rejects template_overrides under environment', () => {
    expect(() =>
      validateAgorYmlSchema({
        environment: {
          variants: { dev: { start: 'x', stop: 'y' } },
          default: 'dev',
          template_overrides: { foo: 1 },
        },
      })
    ).toThrow(/template_overrides/);
  });
});

describe('parseAgorYmlString', () => {
  it('returns null for documents without an environment block', () => {
    expect(parseAgorYmlString('other: value')).toBeNull();
  });

  it('parses v2 variants from a string', () => {
    const env = parseAgorYmlString(
      `environment:
  default: dev
  variants:
    dev:
      start: "pnpm dev"
      stop: "pkill pnpm"`
    );
    expect(env?.default).toBe('dev');
    expect(env?.variants.dev).toEqual({ start: 'pnpm dev', stop: 'pkill pnpm' });
  });
});

describe('resolveVariant', () => {
  it('returns null on missing variant', () => {
    expect(
      resolveVariant(
        {
          version: 2,
          default: 'dev',
          variants: { dev: { start: 'x', stop: 'y' } },
        },
        'nope'
      )
    ).toBeNull();
  });

  it('merges parent fields under child, strips extends', () => {
    const merged = resolveVariant(
      {
        version: 2,
        default: 'child',
        variants: {
          parent: { start: 'up', stop: 'down', nuke: 'kill' },
          child: { extends: 'parent', start: 'override-up' },
        },
      },
      'child'
    );
    expect(merged).toEqual({ start: 'override-up', stop: 'down', nuke: 'kill' });
  });
});
