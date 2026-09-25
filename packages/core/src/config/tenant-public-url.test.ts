import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { TenantPublicRoutingRepository } from '../db/repositories/tenant-public-routing';
import { runWithTenantContext, runWithTenantDatabaseTransaction } from '../db/tenant-scope';
import { dbTest } from '../db/test-helpers';
import type { ArtifactID, BoardID, BranchID, SessionID } from '../types/id';
import {
  getArtifactFullscreenUrl,
  getArtifactUrl,
  getBoardUrl,
  getBranchUrl,
  getKnowledgeUrl,
  getSessionUrl,
} from '../utils/url';
import {
  __resetConfigCacheForTests,
  getBaseUrl,
  getDaemonBaseUrl,
  requirePublicBaseUrl,
} from './config-manager';

describe('hosted public entity URL resolution', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-tenant-url-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('AGOR_BASE_URL', 'https://cell.example.test');
    vi.stubEnv('AGOR_DB_DIALECT', undefined);
    vi.stubEnv('DATABASE_URL', undefined);
    await fs.mkdir(path.join(home, '.agor'));
    __resetConfigCacheForTests();
  });
  async function enableHostedConfig() {
    await fs.writeFile(
      path.join(home, '.agor/config.yaml'),
      `
database:
  dialect: postgresql
multi_tenancy:
  mode: required_from_auth
  auth_claim: tenant_id
  filesystem_isolation_enabled: true
execution:
  branch_storage:
    default_mode: clone
    allowed_modes: [clone]
`
    );
    __resetConfigCacheForTests();
  }
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __resetConfigCacheForTests();
    await fs.rm(home, { recursive: true, force: true });
  });

  dbTest(
    'uses tenant routing for every entity link but leaves OAuth on the deployment origin',
    async ({ db }) => {
      await enableHostedConfig();
      await runWithTenantDatabaseTransaction(db, 'tenant-a', (scoped) =>
        new TenantPublicRoutingRepository(scoped).observeVerifiedLaunch({
          public_base_url: 'https://tenant-a.example.test',
          assertion_issued_at: 100,
        })
      );
      await runWithTenantContext('tenant-a', async () => {
        const base = await getBaseUrl(db);
        expect(base).toBe('https://tenant-a.example.test');
        const id = '01900000-0000-7000-8000-000000000001';
        const urls = [
          getBoardUrl(id as BoardID, 'board', base),
          getSessionUrl(id as SessionID, base),
          getBranchUrl(id as BranchID, base),
          getArtifactUrl(id as ArtifactID, base),
          getArtifactFullscreenUrl(id as ArtifactID, base),
          getKnowledgeUrl('team', 'docs/a b.md', base),
        ];
        for (const url of urls) expect(new URL(url).origin).toBe(base);
        expect(urls[5]).toBe(`${base}/ui/kb/team/docs/a%20b.md`);
        expect(urls[5]).not.toContain('mode=edit');
        await expect(getDaemonBaseUrl()).resolves.toBe('https://cell.example.test');
        await expect(requirePublicBaseUrl()).resolves.toBe('https://cell.example.test');
      });
    }
  );

  dbTest(
    'does not use the cell fallback before first launch or without trusted identity',
    async ({ db }) => {
      await enableHostedConfig();
      await expect(getBaseUrl(db)).rejects.toThrow('trusted tenant identity');
      await runWithTenantContext('tenant-a', async () => {
        await expect(getBaseUrl(db)).resolves.toBe('');
        expect(getKnowledgeUrl('team', 'readme.md', await getBaseUrl(db))).toBe('');
      });
    }
  );
});
