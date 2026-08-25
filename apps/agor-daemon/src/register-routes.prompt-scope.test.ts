import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

  it('enforces branch prompt RBAC before admitting a Task (repository admission bypasses the tasks.create hook)', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const promptEnd = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart, promptEnd);

    // The check must run before the durable Task admission — otherwise a
    // 'session'-tier collaborator prompting another user's session would be
    // admitted (and run under the owner's identity/home) instead of 403'd.
    const rbacCheck = prompt.indexOf('resolveSessionPromptAccess({');
    const taskAdmission = prompt.indexOf('taskRepo.createPending(');
    expect(rbacCheck).toBeGreaterThan(0);
    expect(taskAdmission).toBeGreaterThan(0);
    expect(rbacCheck).toBeLessThan(taskAdmission);

    // Internal/daemon callers (spawn-prompt forward, widgets, scheduler,
    // gateway) and explicit daemon service accounts are exempt from the user-facing
    // branch check.
    expect(prompt).toContain('const isInternalPrompt = !params.provider;');
    expect(prompt).toContain('_isServiceAccount');
    expect(prompt).toContain('branchRbacEnabled && !isInternalPrompt');
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
  });

  it('commits required session configuration before using ordinary prompt admission', () => {
    const start = source.indexOf("'/sessions/:id/initialize'");
    const end = source.indexOf('// Health endpoint', start);
    const initialization = source.slice(start - 100, end);

    expect(start).toBeGreaterThan(0);
    expect(initialization).toContain('registerLongAuthenticatedRoute(');
    expect(initialization).toContain('data?.expectedUserId !== callerId');
    const scopedAuthorization = initialization.indexOf(
      'await inCurrentTenantDatabaseScope(() =>\n          authorizeAndLoadSessionForMcpConfig(id, params)'
    );
    const stagedInitialization = initialization.indexOf('runSessionInitializationStages({');
    expect(scopedAuthorization).toBeGreaterThan(0);
    expect(stagedInitialization).toBeGreaterThan(scopedAuthorization);
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
    const userLookup = drain.indexOf('userRepo.findById(userId)');
    const sessionRead = drain.indexOf('sessionsService.get(sessionId, taskParams)');
    expect(userLookup).toBeGreaterThan(0);
    expect(sessionRead).toBeGreaterThan(userLookup);
    expect(drain).toContain(
      'reconcileSessionPromptStateIfStuck(queuedSession, taskRepo, taskParams)'
    );
    expect(drain).not.toContain('event=drain_started');
    expect(drain).toContain('event=dispatched');
  });
});
