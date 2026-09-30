import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveOwnerHomeStore,
  resolveSandboxProtectedDataRoots,
  resolveSandboxStoragePaths,
  validateFilesystemHomeOverride,
} from './sandbox-context';

describe('relocated daemon state protection', () => {
  beforeEach(() => vi.stubEnv('AGOR_HOME', '/srv/agor-state'));
  afterEach(() => vi.unstubAllEnvs());

  it.each([false, true])(
    'protects state independently of data (tenant isolation: %s)',
    (isolated) => {
      const config = {
        paths: { data_home: '/mnt/git-data' },
        multi_tenancy: {
          filesystem_isolation_enabled: isolated,
          tenants_base_folder: '/mnt/tenant-data',
        },
      };
      const expected = ['/srv/agor-state', '/mnt/git-data'];
      if (isolated) expected.push('/mnt/tenant-data');
      expect(resolveSandboxProtectedDataRoots(config)).toEqual(expected);
      for (const tenantId of ['tenant-a', 'tenant-b']) {
        expect(resolveSandboxStoragePaths(config, tenantId).protectedDataRoots).toEqual(expected);
      }
      // An explicit user-home bind must not re-expose the protected state root.
      expect(() =>
        resolveOwnerHomeStore({
          config,
          tenantId: 'tenant-a',
          ownerUserId: 'user-a',
          filesystemHome: '/srv/agor-state',
        })
      ).toThrow(/data root/i);
    }
  );

  it('deduplicates the default shared state/data root', () => {
    expect(resolveSandboxProtectedDataRoots({})).toEqual(['/srv/agor-state']);
  });
});

describe('validateFilesystemHomeOverride', () => {
  const DATA = '/srv/agor/.agor';

  it('rejects relative paths outright (no silent cwd resolution)', () => {
    expect(() => validateFilesystemHomeOverride('tmp/user', DATA)).toThrow(/absolute/i);
    expect(() => validateFilesystemHomeOverride('../escape', DATA)).toThrow(/absolute/i);
  });

  it('rejects the filesystem root', () => {
    expect(() => validateFilesystemHomeOverride('/', DATA)).toThrow(/root/i);
  });

  it('rejects overlap with the data root (self, ancestor, descendant)', () => {
    expect(() => validateFilesystemHomeOverride(DATA, DATA)).toThrow(/data root/i);
    expect(() => validateFilesystemHomeOverride('/srv/agor', DATA)).toThrow(/data root/i); // ancestor
    expect(() => validateFilesystemHomeOverride(`${DATA}/tenants/x`, DATA)).toThrow(/data root/i); // inside
  });

  it('accepts a clean absolute home outside the data root', () => {
    expect(validateFilesystemHomeOverride('/home/evan', DATA)).toBe('/home/evan');
  });

  describe('with real dirs on disk', () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'agor-fsh-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('canonicalizes a symlinked override so data-root overlap is still caught', () => {
      const realData = join(root, 'real-data');
      const insideData = join(realData, 'tenants');
      mkdirSync(insideData, { recursive: true });
      // An override that is a symlink pointing INTO the data root. Lexically it
      // looks unrelated, but realpath resolves it to inside the data root → reject.
      const sneaky = join(root, 'looks-innocent');
      symlinkSync(insideData, sneaky);
      expect(() => validateFilesystemHomeOverride(sneaky, realData)).toThrow(/data root/i);
    });
  });
});

describe('resolveOwnerHomeStore', () => {
  it('uses the validated filesystem_home override when set', () => {
    expect(
      resolveOwnerHomeStore({
        config: { paths: { data_home: '/srv/agor/.agor' } },
        tenantId: 't1',
        ownerUserId: 'u1',
        filesystemHome: '/home/anna',
      })
    ).toBe('/home/anna');
  });

  it('falls back to the canonical tenant-scoped store when no override', () => {
    expect(
      resolveOwnerHomeStore({
        config: { paths: { data_home: '/srv/agor/.agor' } },
        tenantId: 't1',
        ownerUserId: 'u1',
      })
    ).toBe('/srv/agor/.agor/tenants/t1/homes/u1');
  });

  it('defaults tenant to "default"', () => {
    expect(
      resolveOwnerHomeStore({
        config: { paths: { data_home: '/d' } },
        tenantId: undefined,
        ownerUserId: 'u1',
      })
    ).toBe('/d/tenants/default/homes/u1');
  });

  it('uses the configured tenant root when filesystem isolation is enabled', () => {
    expect(
      resolveOwnerHomeStore({
        config: {
          paths: { data_home: '/srv/agor' },
          multi_tenancy: {
            filesystem_isolation_enabled: true,
            tenants_base_folder: '/mnt/tenants',
          },
        },
        tenantId: 'tenant-a',
        ownerUserId: 'u1',
      })
    ).toBe('/mnt/tenants/tenant-a/homes/u1');
  });

  it('canonicalizes a symlinked data root before returning a prospective owner store', () => {
    const root = mkdtempSync(join(tmpdir(), 'agor-owner-home-'));
    try {
      const canonicalData = join(root, 'canonical-data');
      const linkedData = join(root, 'linked-data');
      mkdirSync(canonicalData, { recursive: true });
      symlinkSync(canonicalData, linkedData);
      expect(
        resolveOwnerHomeStore({
          config: { paths: { data_home: linkedData } },
          tenantId: 'tenant-a',
          ownerUserId: 'user-a',
        })
      ).toBe(join(canonicalData, 'tenants', 'tenant-a', 'homes', 'user-a'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not follow an existing per-user store symlink while canonicalizing trusted roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'agor-owner-home-link-'));
    try {
      const data = join(root, 'data');
      const homes = join(data, 'tenants', 'tenant-a', 'homes');
      const outside = join(root, 'outside');
      mkdirSync(homes, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(homes, 'user-a'));
      expect(
        resolveOwnerHomeStore({
          config: { paths: { data_home: data } },
          tenantId: 'tenant-a',
          ownerUserId: 'user-a',
        })
      ).toBe(join(homes, 'user-a'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
