import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import {
  AppVariableRepository,
  createDatabase,
  type Database,
  initializeDatabase,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  TENANT_DISPLAY_LABEL_KEY,
  TENANT_DISPLAY_NAMESPACE,
  TenantDisplayRepository,
} from '@agor/core/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authenticatedHealthInstance, publicHealthInstance } from './instance';

const config: AgorConfig = {
  daemon: {
    instanceLabel: 'config-label',
    instanceDescription: 'Shared **description**',
    externalAppLink: 'https://console.example.test/',
    externalAppLabel: 'Open Agor Cloud',
  },
};

describe('/health instance', () => {
  let db: Database;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agor-health-instance-test-'));
    db = createDatabase({ url: `file:${join(dir, 'test.db')}` });
    await initializeDatabase(db);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const readTenant = () =>
    runWithTenantDatabaseScope(db, 'default', (scoped) =>
      new TenantDisplayRepository(scoped).find()
    );

  it('returns the tenant label only to authenticated callers, keeping config description', async () => {
    await runWithTenantDatabaseTransaction(db, 'default', (scoped) =>
      new TenantDisplayRepository(scoped).observeVerifiedLaunch({
        label: 'Tenant label',
        assertion_issued_at: 100,
      })
    );
    await expect(authenticatedHealthInstance(config, readTenant)).resolves.toEqual({
      label: 'Tenant label',
      description: 'Shared **description**',
      externalAppLink: 'https://console.example.test/',
      externalAppLabel: 'Open Agor Cloud',
    });
    expect(JSON.stringify(publicHealthInstance(config))).not.toContain('Tenant label');
    expect(publicHealthInstance(config)).toEqual({
      label: 'config-label',
      description: 'Shared **description**',
      externalAppLink: 'https://console.example.test/',
      externalAppLabel: 'Open Agor Cloud',
    });
  });

  it('falls back to config, then nothing, when no tenant label is stored', async () => {
    await expect(authenticatedHealthInstance(config, readTenant)).resolves.toMatchObject({
      label: 'config-label',
    });
    await expect(authenticatedHealthInstance({}, readTenant)).resolves.toEqual({
      label: undefined,
      description: undefined,
    });
  });

  it('falls back to config for a corrupt or unreadable tenant label', async () => {
    await new AppVariableRepository(db).set({
      namespace: TENANT_DISPLAY_NAMESPACE,
      key: TENANT_DISPLAY_LABEL_KEY,
      value: '{invalid',
    });
    await expect(authenticatedHealthInstance(config, readTenant)).resolves.toMatchObject({
      label: 'config-label',
    });
    await expect(
      authenticatedHealthInstance(config, () => Promise.reject(new Error('db down')))
    ).resolves.toMatchObject({ label: 'config-label' });
  });

  it('reads the tenant label only inside the authenticated /health branch', () => {
    const source = readFileSync(new URL('../register-routes.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.use('/health'");
    const health = source.slice(start, source.indexOf('// ====', start));
    const authenticatedAt = health.indexOf('if (isAuthenticated)');
    expect(authenticatedAt).toBeGreaterThan(0);
    const publicPart = health.slice(0, authenticatedAt);
    expect(publicPart).toContain('instance: publicHealthInstance(config)');
    expect(publicPart).not.toContain('TenantDisplayRepository');
    expect(publicPart).not.toContain('authenticatedHealthInstance');
    expect(health.slice(authenticatedAt)).toContain('authenticatedHealthInstance(config');
  });
});
