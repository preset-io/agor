/**
 * SQLite-safe unit coverage for the tenant write gate. The database-backed
 * acquire/release/continuity behavior against real RLS is exercised by the
 * gated PostgreSQL suite (`tenant-write-gate.postgres.test.ts`); here we verify
 * the dialect guards, the fail-open behavior on the single-tenant SQLite schema,
 * and the error contracts.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { initializeDatabase } from './migrate';
import {
  acquireTenantWriteGate,
  assertTenantWritable,
  inspectTenantWriteGate,
  isTenantWriteMethodName,
  readTenantWriteGate,
  releaseTenantWriteGate,
  TENANT_WRITE_GATE_KEY,
  TENANT_WRITE_GATE_NAMESPACE,
  TenantWriteGateGenerationError,
  TenantWriteGateUnsupportedError,
} from './tenant-write-gate';

let scratch: string;
let db: Database;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agor-write-gate-'));
  db = createDatabase({ url: `file:${join(scratch, 'gate.db')}` });
  await initializeDatabase(db);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('tenant write gate on the single-tenant (SQLite) schema', () => {
  it('reports inactive and never blocks writes', async () => {
    const state = await readTenantWriteGate(db, 'default');
    expect(state.active).toBe(false);
    // Enforcement is a no-op on SQLite: this must not throw.
    await expect(assertTenantWritable(db, 'default')).resolves.toBeUndefined();
  });

  it('refuses mutating gate operations (PostgreSQL-only)', async () => {
    await expect(acquireTenantWriteGate(db, 'default')).rejects.toBeInstanceOf(
      TenantWriteGateUnsupportedError
    );
    await expect(inspectTenantWriteGate(db, 'default')).rejects.toBeInstanceOf(
      TenantWriteGateUnsupportedError
    );
    await expect(releaseTenantWriteGate(db, 'default', { generation: 'x' })).rejects.toBeInstanceOf(
      TenantWriteGateUnsupportedError
    );
  });
});

describe('reserved coordinates', () => {
  it('are stable identifiers used to store the gate record', () => {
    expect(TENANT_WRITE_GATE_NAMESPACE).toBe('agor:tenant-write-gate');
    expect(TENANT_WRITE_GATE_KEY).toBe('state');
  });
});

describe('isTenantWriteMethodName', () => {
  it('classifies read methods as non-writes', () => {
    for (const name of [
      'get',
      'getById',
      'findAll',
      'findEnabledTenantRefs',
      'list',
      'listServers',
      'count',
      'countBySession',
      'exists',
      'hasApiKey',
      'isEnabled',
      'canMutate',
      'resolveUserAccess',
      'searchStories',
    ]) {
      expect(isTenantWriteMethodName(name)).toBe(false);
    }
  });

  it('classifies mutators as writes, failing closed on unknown names', () => {
    for (const name of [
      'create',
      'update',
      'delete',
      'patch',
      'remove',
      'upsertBoardObject',
      'completeReplyAdmission',
      'markConsumed',
      'setPrimaryAgenticToolIfUnset',
      'setPrimaryTeammate',
      'setPrimaryTeammateIfUnset',
      'updateLastMessage',
      'clearZoneReferences',
      'revoke',
      'unresolve',
      // Compound mutator beginning with a read-ish verb still writes.
      'getOrCreateNode',
      // Unrecognised verb: fail closed to a write.
      'frobnicate',
    ]) {
      expect(isTenantWriteMethodName(name)).toBe(true);
    }
  });
});

describe('error contracts', () => {
  it('generation error carries expected and actual', () => {
    const error = new TenantWriteGateGenerationError('acme', 'gen-a', 'gen-b');
    expect(error.expected).toBe('gen-a');
    expect(error.actual).toBe('gen-b');
    expect(error.name).toBe('TenantWriteGateGenerationError');
  });
});
