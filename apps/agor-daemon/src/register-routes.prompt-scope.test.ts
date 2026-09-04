import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { Task, User } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { assertTaskExecutorPrincipal, resolveQueuedTaskActor } from './register-routes';

describe('prompt and widget transaction scopes', () => {
  const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');

  it('uses long-route admission and short Task repository units without a duplicate gate check', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const promptEnd = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart - 100, promptEnd);

    expect(promptStart).toBeGreaterThan(0);
    expect(prompt).toContain('registerLongAuthenticatedRoute(');
    expect(prompt).not.toContain('assertTenantWriteAdmission(');
    expect(prompt).toContain('bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db))');
    expect(prompt).toContain(
      'isAgenticToolEnabledForTenant(db, promptTenantId, activeAgenticTool)'
    );
    expect(prompt).not.toContain(
      "registerAuthenticatedRoute(\n    app,\n    '/sessions/:id/prompt'"
    );
  });

  it('rechecks branch prompt RBAC inside the durable Task-admission transaction', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const promptEnd = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart, promptEnd);

    // The check must run before the durable Task admission — otherwise a
    // 'session'-tier collaborator prompting another user's session would be
    // admitted (and run under the owner's identity/home) instead of 403'd.
    const transaction = prompt.indexOf('runWithTenantDatabaseTransaction(');
    const authorityLock = prompt.indexOf('lockTenantAuthorizationFence(operationDb, params)');
    const rbacCheck = prompt.lastIndexOf('assertCurrentPromptAuthority(');
    const taskAdmission = prompt.indexOf('new TaskRepository(operationDb).createPending(');
    expect(transaction).toBeGreaterThan(0);
    expect(authorityLock).toBeGreaterThan(transaction);
    expect(rbacCheck).toBeGreaterThan(authorityLock);
    expect(taskAdmission).toBeGreaterThan(0);
    expect(rbacCheck).toBeLessThan(taskAdmission);

    // Provider-less human actions still carry the real prompt actor and use
    // the same authority boundary. Only explicit daemon service accounts are
    // exempt from the user-facing check.
    expect(prompt).not.toContain('const isInternalPrompt = !params.provider;');
    expect(prompt).toContain('_isServiceAccount');
    expect(prompt).toContain('if (!isPromptServiceAccount && promptBranchId)');
  });

  it('does not keep a route-wide tenant transaction over widget external work', () => {
    for (const path of ["'/widgets/:id/submit'", "'/widgets/:id/dismiss'"]) {
      const start = source.indexOf(path);
      const route = source.slice(start - 100, start + 900);
      expect(start).toBeGreaterThan(0);
      expect(route).toContain('registerLongAuthenticatedRoute(');
    }
  });

  it('routes prompt admission and explicit Task runs through server-owned provenance', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const runStart = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart, runStart);
    const run = source.slice(runStart, source.indexOf("'/sessions/:id/spawn-prompt'", runStart));

    expect(prompt).toContain('normalizeMessageSource(data.messageSource, params)');
    expect(prompt).toContain('buildPromptTaskMetadata(data.metadata, messageSource, createdBy');
    expect(run).toContain('messageSource: normalizeMessageSource(data.messageSource, params)');
    expect(run).toContain('assertTaskExecutorPrincipal(task, params)');
  });

  it("does not let a collaborator run another actor's pre-created Task", () => {
    const task = { created_by: 'actor-a' } as Pick<Task, 'created_by'>;

    expect(assertTaskExecutorPrincipal(task, { user: { user_id: 'actor-a' } as User })).toBe(
      'actor-a'
    );
    expect(() =>
      assertTaskExecutorPrincipal(task, { user: { user_id: 'actor-b' } as User })
    ).toThrow(Forbidden);
    expect(() => assertTaskExecutorPrincipal(task, {})).toThrow(NotAuthenticated);
  });

  it('finalizes executor spawn failures as trusted daemon writes', () => {
    const catchStart = source.indexOf('const failureParams = { ...params, provider: undefined };');
    const catchEnd = source.indexOf('Failed to emit tasks:failed event', catchStart);
    const spawnFailure = source.slice(catchStart, catchEnd);

    expect(catchStart).toBeGreaterThan(0);
    expect(catchEnd).toBeGreaterThan(catchStart);
    expect(spawnFailure).toContain("'Task',\n          failureParams");
    expect(spawnFailure).toContain('params: failureParams');
  });

  it('commits required session configuration before using ordinary prompt admission', () => {
    const start = source.indexOf("'/sessions/:id/initialize'");
    const end = source.indexOf('// Health endpoint', start);
    const initialization = source.slice(start - 100, end);

    expect(start).toBeGreaterThan(0);
    expect(initialization).toContain('registerLongAuthenticatedRoute(');
    expect(initialization).toContain('data?.expectedUserId !== callerId');
    const scopedAuthorization = initialization.indexOf(
      'await inCurrentTenantDatabaseScope(async () => {'
    );
    const ownerCheck = initialization.indexOf(
      'requireSessionScopedConfigOwnerOrAdmin(id, params)',
      scopedAuthorization
    );
    const stagedInitialization = initialization.indexOf('runSessionInitializationStages({');
    expect(scopedAuthorization).toBeGreaterThan(0);
    expect(ownerCheck).toBeGreaterThan(scopedAuthorization);
    expect(stagedInitialization).toBeGreaterThan(ownerCheck);
    const mcpSetup = initialization.indexOf('sessionMCPServersService.setServers(');
    const envSetup = initialization.indexOf('sessionEnvSelectionsService.setAll(');
    const promptAdmission = initialization.indexOf("service('/sessions/:id/prompt').create(");
    expect(mcpSetup).toBeGreaterThan(0);
    expect(envSetup).toBeGreaterThan(mcpSetup);
    expect(promptAdmission).toBeGreaterThan(envSetup);
    expect(initialization.indexOf("path: 'session-mcp-servers'")).toBeLessThan(promptAdmission);
    expect(initialization.indexOf("path: 'session-env-selections'")).toBeLessThan(promptAdmission);
  });

  it('restores the queued user before hooked Session recovery under branch RBAC', () => {
    const start = source.indexOf('async function processNextQueuedTaskInternal(');
    const end = source.indexOf('// Inject queue processor into sessions service.', start);
    const drain = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    const canonicalActor = drain.indexOf('resolveQueuedTaskActor(nextTask');
    const userLookup = drain.indexOf('userRepo.findById(userId)');
    const sessionRead = drain.indexOf('sessionsService.get(sessionId, taskParams)');
    expect(canonicalActor).toBeGreaterThan(0);
    expect(userLookup).toBeGreaterThan(0);
    expect(userLookup).toBeGreaterThan(canonicalActor);
    expect(sessionRead).toBeGreaterThan(userLookup);
    expect(drain).not.toContain('metadata?.queued_by_user_id ?? nextTask.created_by');
    expect(drain).toContain('event=actor_missing');
    expect(drain).toContain(
      'reconcileSessionPromptStateIfStuck(queuedSession, taskRepo, taskParams)'
    );
    expect(drain).not.toContain('event=drain_started');
    expect(drain).toContain('event=dispatched');
  });

  it('uses Task.created_by even when legacy queue metadata names someone else', async () => {
    const task = {
      created_by: 'caller-c',
      metadata: { queued_by_user_id: 'ambient-b' },
    } as unknown as Task;
    const caller = { user_id: 'caller-c' } as User;
    const findUser = vi.fn(async (userId: string) =>
      userId === caller.user_id ? caller : undefined
    );

    await expect(resolveQueuedTaskActor(task, findUser)).resolves.toBe(caller);
    expect(findUser).toHaveBeenCalledOnce();
    expect(findUser).toHaveBeenCalledWith('caller-c');
  });

  it('fails closed when the durable queued Task actor no longer exists', async () => {
    const findUser = vi.fn(async () => undefined);

    await expect(
      resolveQueuedTaskActor({ created_by: 'deleted-caller' } as Pick<Task, 'created_by'>, findUser)
    ).resolves.toBeNull();
    expect(findUser).toHaveBeenCalledWith('deleted-caller');
  });
});
