import { describe, expect, it } from 'vitest';
import {
  runWithTenantContext,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
} from '../tenant-scope';
import { dbTest } from '../test-helpers';
import { AppVariableRepository } from './app-variables';
import {
  getTenantPublicBaseUrl,
  publicBaseUrlMatchesRequestHost,
  TENANT_PUBLIC_ROUTING_KEY,
  TENANT_PUBLIC_ROUTING_NAMESPACE,
  TenantPublicRoutingDiscoveryRepository,
  TenantPublicRoutingRepository,
  validateTenantPublicRouting,
} from './tenant-public-routing';

describe('tenant public routing', () => {
  it.each(['https://team.example.test/', 'http://localhost:3030/'])(
    'accepts trusted HTTP(S) origins including local ports: %s',
    (url) => {
      expect(validateTenantPublicRouting(url, 100).public_base_url).toBe(url.slice(0, -1));
    }
  );
  it.each([
    '',
    null,
    42,
    '//evil.test',
    'javascript:alert(1)',
    'https://user:secret@host.test',
    'https://host.test?token=secret',
    'https://host.test#secret',
    'https://host.test?',
    'https://host.test/\npath',
    'https://host.test\\evil',
    'https://host.test/ui',
    'https://host.test/agor/',
    'https://host.test/./',
    'https://host.test\u0000',
  ])('rejects malformed metadata without echoing it: %s', (url) => {
    expect(() => validateTenantPublicRouting(url, 100)).toThrow(
      'Invalid tenant public routing metadata'
    );
  });
  it.each([undefined, null, -1, 1.5, Infinity, '100'])(
    'requires a signed integer iat: %s',
    (iat) => {
      expect(() => validateTenantPublicRouting('https://team.test', iat)).toThrow();
    }
  );

  dbTest(
    'persists across independent contexts, ignores stale observations, and reads updates without a cache',
    async ({ db }) => {
      const observe = (public_base_url: string, assertion_issued_at: number) =>
        runWithTenantDatabaseTransaction(db, 'tenant-a', (scoped) =>
          new TenantPublicRoutingRepository(scoped).observeVerifiedLaunch({
            public_base_url,
            assertion_issued_at,
          })
        );
      const read = () => runWithTenantContext('tenant-a', () => getTenantPublicBaseUrl(db));
      await expect(read()).resolves.toBe('');
      await observe('https://a.test', 100);
      await expect(read()).resolves.toBe('https://a.test');
      await observe('https://stale.test', 99);
      await observe('https://equal.test', 100);
      await expect(read()).resolves.toBe('https://a.test');
      await observe('https://new.test', 101);
      await expect(read()).resolves.toBe('https://new.test');
      await runWithTenantDatabaseScope(db, 'tenant-a', () =>
        expect(getTenantPublicBaseUrl()).resolves.toBe('https://new.test')
      );
    }
  );

  dbTest('rejects missing/conflicting identity and untransactional writes', async ({ db }) => {
    await expect(getTenantPublicBaseUrl(db)).rejects.toThrow('trusted tenant identity');
    await runWithTenantDatabaseScope(db, 'tenant-b', () =>
      runWithTenantContext('tenant-a', () =>
        expect(getTenantPublicBaseUrl(db)).rejects.toThrow('active tenant scope')
      )
    );
    await runWithTenantDatabaseScope(db, 'tenant-a', (scoped) =>
      expect(
        new TenantPublicRoutingRepository(scoped).observeVerifiedLaunch({
          public_base_url: 'https://a.test',
          assertion_issued_at: 100,
        })
      ).rejects.toThrow('active tenant transaction')
    );
  });

  dbTest('fails closed on corrupted stored metadata', async ({ db }) => {
    await new AppVariableRepository(db).set({
      namespace: TENANT_PUBLIC_ROUTING_NAMESPACE,
      key: TENANT_PUBLIC_ROUTING_KEY,
      value: '{invalid',
    });
    await runWithTenantContext('tenant-a', () =>
      expect(getTenantPublicBaseUrl(db)).rejects.toThrow(
        'Invalid stored tenant public routing metadata'
      )
    );
  });

  dbTest('does not reuse an imported observation bound to another tenant', async ({ db }) => {
    await new AppVariableRepository(db).set({
      namespace: TENANT_PUBLIC_ROUTING_NAMESPACE,
      key: TENANT_PUBLIC_ROUTING_KEY,
      value: JSON.stringify({
        tenant_id: 'source-tenant',
        public_base_url: 'https://source.test',
        assertion_issued_at: 999,
      }),
    });
    await runWithTenantContext('destination-tenant', () =>
      expect(getTenantPublicBaseUrl(db)).resolves.toBe('')
    );
    await runWithTenantDatabaseTransaction(db, 'destination-tenant', (scoped) =>
      new TenantPublicRoutingRepository(scoped).observeVerifiedLaunch({
        public_base_url: 'https://destination.test',
        assertion_issued_at: 100,
      })
    );
    await runWithTenantContext('destination-tenant', () =>
      expect(getTenantPublicBaseUrl(db)).resolves.toBe('https://destination.test')
    );
  });

  describe('publicBaseUrlMatchesRequestHost', () => {
    it.each([
      ['https://ws.example.test', 'ws.example.test'],
      ['https://ws.example.test', 'WS.Example.TEST'],
      ['https://ws.example.test', 'ws.example.test:443'],
      ['http://localhost:3030', 'localhost:3030'],
      ['https://ws.example.test:8443', 'ws.example.test:8443'],
    ])('matches %s for Host %s', (publicBaseUrl, host) => {
      expect(publicBaseUrlMatchesRequestHost(publicBaseUrl, host)).toBe(true);
    });

    it.each([
      ['https://ws.example.test', 'other.example.test'],
      ['https://ws.example.test', 'evil.ws.example.test'],
      ['https://ws.example.test', 'ws.example.test.evil.test'],
      ['https://ws.example.test', 'ws.example.test:8443'],
      ['https://ws.example.test', 'ws.example.test:80'],
      ['http://localhost:3030', 'localhost'],
      ['https://ws.example.test', 'ws.example.test/path'],
      ['https://ws.example.test', 'user@ws.example.test'],
      ['https://ws.example.test', 'ws.example.test,other.example.test'],
      ['https://ws.example.test', 'ws.example.test other.example.test'],
      ['https://ws.example.test', 'ws.example.test?x=1'],
      ['https://ws.example.test', 'ws.example.test#x'],
      ['https://ws.example.test', ''],
      ['https://ws.example.test/ui', 'ws.example.test'],
      ['not a url', 'ws.example.test'],
    ])('rejects %s for Host %s', (publicBaseUrl, host) => {
      expect(publicBaseUrlMatchesRequestHost(publicBaseUrl, host)).toBe(false);
    });
  });

  dbTest('refuses host discovery outside PostgreSQL', async ({ db }) => {
    expect(() => new TenantPublicRoutingDiscoveryRepository(db as never)).toThrow(
      'requires PostgreSQL'
    );
  });
});
