/**
 * SQLite-safe ordering coverage for `importTenant`: a crafted, self-consistent
 * archive whose symlink target escapes the tenant root must be rejected BEFORE
 * any database access — otherwise the CLI's "rejected before any data was
 * modified" hint would be a lie once the database has been mutated. We prove the
 * ordering without a live database by passing a `db` proxy that throws on ANY
 * access: if the escaping link is caught first, that proxy is never touched.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_HEADER_REDACTED_SENTINEL } from '../tools/mcp/http-headers';
import type { Database } from './client';
import {
  computeContentFingerprint,
  databaseDir,
  filesDir,
  sha256Hex,
  TENANT_ARCHIVE_MANIFEST_VERSION,
  type TenantArchiveManifest,
  tableJsonlPath,
  writeManifest,
} from './tenant-archive';
import type { TenantDatabaseIdentity } from './tenant-catalog';
import { UnsafeArchivePathError } from './tenant-filesystem';
import { importTenant, validateArchivedMCPCompatibilityModes } from './tenant-import';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agor-tenant-import-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const identity: TenantDatabaseIdentity = {
  dialect: 'postgresql',
  schemaVersion: '0072_example',
  migrations: ['0000_a', '0072_example'],
  tenantTables: [],
  nonPortableTenantTables: [
    'executor_session_token_authorities',
    'mcp_oauth_client_registrations',
    'mcp_oauth_pending_flows',
    'user_mcp_oauth_tokens',
  ],
  presentImperativeTables: [],
  fingerprint: sha256Hex('identity'),
};

/**
 * Write a self-consistent (correctly-fingerprinted) archive containing exactly
 * one symlink entry with the given stored target, and materialise a real symlink
 * in `files/` so integrity checking passes. Tables are empty, so nothing but the
 * symlink governs whether the import is rejected.
 */
async function writeArchiveWithSymlink(root: string, linkTarget: string): Promise<void> {
  const entryPath = 'sub/link';
  const base: Pick<
    TenantArchiveManifest,
    'manifestVersion' | 'tenantId' | 'database' | 'filesystem'
  > = {
    manifestVersion: TENANT_ARCHIVE_MANIFEST_VERSION,
    tenantId: 'acme',
    database: { identity, tables: [] },
    filesystem: {
      included: true,
      entries: [{ path: entryPath, type: 'symlink', size: 0, linkTarget, mode: 0o777 }],
      skippedSpecialCount: 0,
      unsafeSymlinkCount: 0,
    },
  };
  const manifest: TenantArchiveManifest = {
    ...base,
    operationId: 'op-craft',
    createdAt: '2026-01-01T00:00:00.000Z',
    contentFingerprint: computeContentFingerprint(base),
  };
  await mkdir(databaseDir(root), { recursive: true });
  const linkOnDisk = join(filesDir(root), entryPath);
  await mkdir(dirname(linkOnDisk), { recursive: true });
  // A real symlink so lstat-based integrity classifies it as a symlink; the
  // target string is what the manifest declares (need not resolve on disk).
  await symlink(linkTarget, linkOnDisk);
  await writeManifest(root, manifest);
}

/** A `db` that fails the test loudly if importTenant touches it. */
function untouchableDb(): Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('database was accessed before the archive was fully validated');
      },
    }
  ) as unknown as Database;
}

describe('importTenant pre-mutation validation ordering', () => {
  it('rejects an escaping symlink target before any database access', async () => {
    await writeArchiveWithSymlink(scratch, '../../../../etc/passwd');
    await expect(importTenant(untouchableDb(), { archivePath: scratch })).rejects.toBeInstanceOf(
      UnsafeArchivePathError
    );
  });

  it('accepts an in-root symlink and only then reaches the database', async () => {
    // A link whose target stays in-root passes the pre-mutation check, so the
    // next step (resolving the live database identity) touches the proxy — the
    // error is the db-access sentinel, NOT a path rejection. This proves the
    // validator does not false-positive and that db access is strictly after it.
    await writeArchiveWithSymlink(scratch, 'real.txt');
    await expect(importTenant(untouchableDb(), { archivePath: scratch })).rejects.toThrow(
      /database was accessed/
    );
  });
});

describe('importTenant MCP OAuth public policy boundary', () => {
  async function archivedMcpManifest(
    mode: unknown,
    headers?: Record<string, string>,
    mutate?: (row: Record<string, unknown>) => void
  ): Promise<TenantArchiveManifest> {
    const row: Record<string, unknown> = {
      tenant_id: 'acme',
      mcp_server_id: '01900000-0000-7000-8000-000000000001',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      name: 'archive-oauth',
      transport: 'http',
      scope: 'global',
      enabled: true,
      owner_user_id: null,
      source: 'user',
      catalog_entry_name: null,
      data: {
        config_version: 1,
        url: 'https://mcp.example.test/mcp',
        auth: { type: 'oauth', oauth_compatibility_mode: mode },
        headers,
      },
    };
    mutate?.(row);
    const line = `${JSON.stringify(row)}\n`;
    await mkdir(databaseDir(scratch), { recursive: true });
    await writeFile(tableJsonlPath(scratch, 'mcp_servers'), line, 'utf8');
    return {
      manifestVersion: TENANT_ARCHIVE_MANIFEST_VERSION,
      tenantId: 'acme',
      operationId: 'op-oauth-policy',
      createdAt: '2026-01-01T00:00:00.000Z',
      contentFingerprint: 'not-used-by-direct-validator',
      database: {
        identity,
        tables: [
          {
            name: 'mcp_servers',
            rowCount: 1,
            sha256: sha256Hex(line),
            bytes: Buffer.byteLength(line),
          },
        ],
      },
      filesystem: { included: false, entries: [], skippedSpecialCount: 0, unsafeSymlinkCount: 0 },
    };
  }

  it.each(['marketplace', 'future-mode'])(
    'rejects archived public compatibility mode %s',
    async (mode) => {
      await expect(
        validateArchivedMCPCompatibilityModes(scratch, await archivedMcpManifest(mode))
      ).rejects.toThrow(/must be either strict or legacy/);
    }
  );

  it.each([undefined, 'strict', 'legacy'])('accepts archived public mode %s', async (mode) => {
    await expect(
      validateArchivedMCPCompatibilityModes(scratch, await archivedMcpManifest(mode))
    ).resolves.toBeUndefined();
  });

  it('rejects case-insensitive duplicate custom headers before import writes', async () => {
    await expect(
      validateArchivedMCPCompatibilityModes(
        scratch,
        await archivedMcpManifest('strict', { 'X-Route': 'a', 'x-route': 'b' })
      )
    ).rejects.toThrow(/Duplicate custom HTTP header names/);
  });

  it.each([
    {
      label: 'unknown top-level secret',
      mutate: (row: Record<string, unknown>) => Object.assign(row, { provider_secret: 'escape' }),
      error: /Unknown archived mcp_servers field: provider_secret/,
    },
    {
      label: 'unknown auth secret',
      mutate: (row: Record<string, unknown>) => {
        const data = row.data as Record<string, unknown>;
        data.auth = { type: 'oauth', provider_secret: 'escape' };
      },
      error: /Unknown auth field: provider_secret/,
    },
    {
      label: 'exhausted config revision',
      mutate: (row: Record<string, unknown>) => {
        (row.data as Record<string, unknown>).config_version = Number.MAX_SAFE_INTEGER;
      },
      error: /non-exhausted positive safe integer/,
    },
    {
      label: 'redaction sentinel',
      mutate: (row: Record<string, unknown>) => {
        (row.data as Record<string, unknown>).auth = {
          type: 'oauth',
          oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
        };
      },
      error: /redaction sentinel/,
    },
    {
      label: 'invalid transport combination',
      mutate: (row: Record<string, unknown>) => {
        row.transport = 'stdio';
      },
      error: /command is required|url does not apply/,
    },
    {
      label: 'mode-mismatched auth',
      mutate: (row: Record<string, unknown>) => {
        (row.data as Record<string, unknown>).auth = { type: 'none', token: 'escape' };
      },
      error: /does not apply/,
    },
    {
      label: 'forged catalog provenance',
      mutate: (row: Record<string, unknown>) => {
        row.source = 'catalog';
      },
      error: /requires catalog_entry_name evidence/,
    },
    {
      label: 'catalog evidence on user provenance',
      mutate: (row: Record<string, unknown>) => {
        (row.data as Record<string, unknown>).catalog_entry_name = 'forged.catalog';
      },
      error: /catalog_entry_name only applies to catalog MCP servers|do not apply/,
    },
  ])('rejects archived MCP $label before import writes', async ({ mutate, error }) => {
    await expect(
      validateArchivedMCPCompatibilityModes(
        scratch,
        await archivedMcpManifest('strict', undefined, mutate)
      )
    ).rejects.toThrow(error);
  });

  it('accepts a bounded legacy imported row for revision reset during restore', async () => {
    await expect(
      validateArchivedMCPCompatibilityModes(
        scratch,
        await archivedMcpManifest('strict', undefined, (row) => {
          row.source = 'imported';
          (row.data as Record<string, unknown>).config_version = 42;
        })
      )
    ).resolves.toBeUndefined();
  });

  it.each([
    { type: 'bearer' as const },
    { type: 'jwt' as const, api_url: 'https://auth.example.test/token' },
  ])(
    'accepts a legal 962f74fe-era incomplete $type row with optional capabilities',
    async (auth) => {
      await expect(
        validateArchivedMCPCompatibilityModes(
          scratch,
          await archivedMcpManifest('strict', undefined, (row) => {
            const data = row.data as Record<string, unknown>;
            data.auth = auth;
            data.tools = [{ name: 'legacy-tool' }];
            data.resources = [{ uri: 'file:///legacy', name: 'legacy', description: 'optional' }];
            data.prompts = [{ name: 'legacy-prompt', arguments: [{ name: 'subject' }] }];
            // A legal base-version row may omit updated_at.
            delete row.updated_at;
          })
        )
      ).resolves.toBeUndefined();
    }
  );
});
