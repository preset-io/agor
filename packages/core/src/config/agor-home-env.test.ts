/**
 * `AGOR_HOME` override resolution and the derived-path contract.
 *
 * The derived-path suite is the point of these tests: a partial implementation
 * that moved `config.yaml` but left the database (or uploads, or the agentic
 * tool tree) in the operator's real home would look like it worked while a
 * throwaway daemon quietly read and wrote live state.
 */

import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgenticToolsRoot } from '../agentic-integrations.js';
import { resolveDatabaseUrl, resolveDefaultDatabaseUrl } from '../db/client.js';
import { agorHomePath, getAgorHome, getConfigPath } from './agor-home.js';
import {
  getBranchesDir,
  getBranchHomesDir,
  getDataHome,
  getDefaultConfig,
  getReposDir,
} from './config-manager.js';

const OS_HOME = '/os-home';

describe('getAgorHome', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(OS_HOME);
    delete process.env.AGOR_HOME;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGOR_HOME;
  });

  it('defaults to <os home>/.agor when AGOR_HOME is unset', () => {
    expect(getAgorHome()).toBe(path.join(OS_HOME, '.agor'));
  });

  it('uses an absolute AGOR_HOME verbatim', () => {
    process.env.AGOR_HOME = '/srv/throwaway-agor';
    expect(getAgorHome()).toBe('/srv/throwaway-agor');
  });

  it('normalizes a non-canonical absolute AGOR_HOME', () => {
    process.env.AGOR_HOME = '/srv/throwaway-agor/nested/../';
    expect(getAgorHome()).toBe('/srv/throwaway-agor');
  });

  it('expands a leading ~ against the operating-system home', () => {
    process.env.AGOR_HOME = '~/scratch/agor';
    expect(getAgorHome()).toBe(path.join(OS_HOME, 'scratch', 'agor'));
  });

  it('expands a bare ~ to the operating-system home', () => {
    process.env.AGOR_HOME = '~';
    expect(getAgorHome()).toBe(OS_HOME);
  });

  it('does not expand ~ that is not a path prefix', () => {
    process.env.AGOR_HOME = '/srv/~backup/agor';
    expect(getAgorHome()).toBe('/srv/~backup/agor');
  });

  it.each(['', '   ', '\t\n'])(
    'treats a blank AGOR_HOME (%j) as unset rather than the filesystem root',
    (blank) => {
      process.env.AGOR_HOME = blank;
      expect(getAgorHome()).toBe(path.join(OS_HOME, '.agor'));
    }
  );

  it('resolves a relative AGOR_HOME against the working directory', () => {
    process.env.AGOR_HOME = 'relative-agor';
    expect(getAgorHome()).toBe(path.resolve(process.cwd(), 'relative-agor'));
  });

  it('trims surrounding whitespace instead of resolving a space-prefixed path', () => {
    process.env.AGOR_HOME = '  /srv/throwaway-agor  ';
    expect(getAgorHome()).toBe('/srv/throwaway-agor');
  });

  it('re-reads the environment on every call rather than caching', () => {
    expect(getAgorHome()).toBe(path.join(OS_HOME, '.agor'));
    process.env.AGOR_HOME = '/srv/first';
    expect(getAgorHome()).toBe('/srv/first');
    process.env.AGOR_HOME = '/srv/second';
    expect(getAgorHome()).toBe('/srv/second');
    delete process.env.AGOR_HOME;
    expect(getAgorHome()).toBe(path.join(OS_HOME, '.agor'));
  });

  it('joins segments onto the effective home', () => {
    process.env.AGOR_HOME = '/srv/throwaway-agor';
    expect(agorHomePath('runtime', 'fences')).toBe('/srv/throwaway-agor/runtime/fences');
  });
});

/**
 * Every Agor-owned path must move together. Each entry reads through the real
 * production resolver, so a new path that forgets `getAgorHome()` fails here.
 */
const DERIVED_PATHS: ReadonlyArray<{ name: string; resolve: () => string }> = [
  { name: 'operator config', resolve: () => getConfigPath() },
  { name: 'standalone database', resolve: () => resolveDefaultDatabaseUrl().replace(/^file:/, '') },
  {
    name: 'resolved database URL without config',
    resolve: () => resolveDatabaseUrl({ config: {}, env: {} }).replace(/^file:/, ''),
  },
  { name: 'data home', resolve: () => getDataHome() },
  { name: 'repos', resolve: () => getReposDir() },
  { name: 'branch worktrees', resolve: () => getBranchesDir() },
  { name: 'branch homes', resolve: () => getBranchHomesDir() },
  { name: 'agentic tools', resolve: () => getAgenticToolsRoot() },
  { name: 'tenants base', resolve: () => getDefaultConfig().multi_tenancy!.tenants_base_folder! },
  { name: 'uploads base', resolve: () => getDefaultConfig().uploads!.location! },
];

describe('AGOR_HOME moves every derived path', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(OS_HOME);
    delete process.env.AGOR_HOME;
    delete process.env.AGOR_DATA_HOME;
    delete process.env.AGOR_AGENTIC_TOOLS_DIR;
    delete process.env.AGOR_DB_PATH;
    delete process.env.AGOR_DB_DIALECT;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGOR_HOME;
  });

  it.each(DERIVED_PATHS)('$name stays under <os home>/.agor when unset', ({ resolve }) => {
    expect(resolve().startsWith(path.join(OS_HOME, '.agor'))).toBe(true);
  });

  it.each(DERIVED_PATHS)('$name relocates under an absolute AGOR_HOME', ({ resolve }) => {
    process.env.AGOR_HOME = '/srv/throwaway-agor';
    const resolved = resolve();
    expect(resolved.startsWith('/srv/throwaway-agor')).toBe(true);
    // The operator's real home must not appear anywhere in the result.
    expect(resolved).not.toContain(path.join(OS_HOME, '.agor'));
  });

  it.each(DERIVED_PATHS)('$name relocates under a ~-relative AGOR_HOME', ({ resolve }) => {
    process.env.AGOR_HOME = '~/scratch/agor';
    expect(resolve().startsWith(path.join(OS_HOME, 'scratch', 'agor'))).toBe(true);
  });

  it.each(DERIVED_PATHS)(
    '$name falls back to the default when AGOR_HOME is blank',
    ({ resolve }) => {
      process.env.AGOR_HOME = '';
      const resolved = resolve();
      expect(resolved.startsWith(path.join(OS_HOME, '.agor'))).toBe(true);
      expect(path.isAbsolute(resolved)).toBe(true);
    }
  );

  it('keeps config and database under one root, not two', () => {
    process.env.AGOR_HOME = '/srv/throwaway-agor';
    expect(path.dirname(getConfigPath())).toBe(
      path.dirname(resolveDefaultDatabaseUrl().replace(/^file:/, ''))
    );
  });
});
