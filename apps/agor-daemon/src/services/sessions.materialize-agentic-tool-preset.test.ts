import {
  AgenticToolPresetRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  getCurrentTenantDatabaseScope,
  RepoRepository,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Session, UserID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { SessionsService } from './sessions';

const STUB_APP = {} as Application;
const ACTOR_ID = '00000000-0000-7000-8000-000000000001' as UserID;

async function seedPresetSession(db: Database) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `repo-${generateId()}`,
    name: 'Tenant scope test repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'tenant-scope-test',
    ref: 'tenant-scope-test',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: ACTOR_ID,
  });
  const preset = await new AgenticToolPresetRepository(db).create(
    {
      tool: 'codex',
      name: 'Task start preset',
      configuration: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
    },
    ACTOR_ID
  );
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'codex',
    agentic_tool_preset_id: preset.preset_id,
    status: SessionStatus.IDLE,
    created_by: ACTOR_ID,
    git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
  });
  return session;
}

describe('SessionsService.materializeAgenticToolPreset tenant scope', () => {
  dbTest('opens a tenant unit of work from identity-only context', async ({ db }) => {
    const session = await seedPresetSession(db);
    const guardedDb = createTenantScopedDatabaseProxy(db, {
      requireScope: true,
      label: 'materialize preset test',
    });
    const service = new SessionsService(guardedDb, STUB_APP);
    const sessionRepo = (service as unknown as { sessionRepo: SessionRepository }).sessionRepo;
    const originalUpdate = sessionRepo.update.bind(sessionRepo);
    const seenScopes: unknown[] = [];
    vi.spyOn(sessionRepo, 'update').mockImplementation(async (...args) => {
      seenScopes.push(getCurrentTenantDatabaseScope());
      return originalUpdate(...args);
    });

    const materialized = await runWithTenantContext('tenant-x', () =>
      service.materializeAgenticToolPreset(session)
    );

    expect(materialized.model_config?.model).toBe('gpt-5.4');
    expect(seenScopes).toHaveLength(1);
    expect(seenScopes[0]).toMatchObject({ kind: 'tenant', tenantId: 'tenant-x' });
    expect(getCurrentTenantDatabaseScope()).toBeUndefined();
  });

  dbTest('joins an existing tenant database scope', async ({ db }) => {
    const session = await seedPresetSession(db);
    const guardedDb = createTenantScopedDatabaseProxy(db, { requireScope: true });
    const service = new SessionsService(guardedDb, STUB_APP);
    const sessionRepo = (service as unknown as { sessionRepo: SessionRepository }).sessionRepo;
    const originalUpdate = sessionRepo.update.bind(sessionRepo);
    let updateScope: unknown;
    vi.spyOn(sessionRepo, 'update').mockImplementation(async (...args) => {
      updateScope = getCurrentTenantDatabaseScope();
      return originalUpdate(...args);
    });

    await runWithTenantContext('tenant-x', () =>
      runWithTenantDatabaseScope(guardedDb, 'tenant-x', async () => {
        const outerScope = getCurrentTenantDatabaseScope();
        await service.materializeAgenticToolPreset(session);
        expect(updateScope).toBe(outerScope);
      })
    );
  });

  dbTest('scopes inline-policy validation when no preset is selected', async ({ db }) => {
    const presetSession = await seedPresetSession(db);
    const inlineSession = {
      ...presetSession,
      agentic_tool_preset_id: null,
    } as Session;
    const guardedDb = createTenantScopedDatabaseProxy(db, { requireScope: true });
    const service = new SessionsService(guardedDb, STUB_APP);

    await expect(
      runWithTenantContext('tenant-x', () => service.materializeAgenticToolPreset(inlineSession))
    ).resolves.toBe(inlineSession);
  });

  dbTest('fails fast for missing or mismatched tenant identity', async ({ db }) => {
    const session = await seedPresetSession(db);
    const guardedDb = createTenantScopedDatabaseProxy(db, { requireScope: true });
    const service = new SessionsService(guardedDb, STUB_APP);

    await expect(service.materializeAgenticToolPreset(session)).rejects.toThrow(
      'Missing active tenant context for agentic tool preset materialization'
    );

    await runWithTenantDatabaseScope(guardedDb, 'tenant-b', async () => {
      await expect(
        runWithTenantContext('tenant-a', () => service.materializeAgenticToolPreset(session))
      ).rejects.toThrow('Cannot enter tenant scope tenant-a from active tenant scope tenant-b');
    });

    await runWithSystemDatabaseScope(guardedDb, 'materialization system test', async () => {
      await expect(
        runWithTenantContext('tenant-a', () => service.materializeAgenticToolPreset(session))
      ).rejects.toThrow('Cannot enter tenant scope tenant-a from active system database scope');
    });
  });
});
