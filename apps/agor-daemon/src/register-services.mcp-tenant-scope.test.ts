import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TENANT_IDENTITY_ONLY_SERVICE_PATHS } from './register-hooks.js';

/**
 * The `/mcp-servers/*` endpoints that perform provider network I/O carry tenant
 * identity only — they must not hold an HTTP-long tenant transaction — so each
 * of their database touches opens its own short tenant unit of work. Against a
 * scope-requiring handle an unscoped touch throws `MissingTenantDatabaseScope`,
 * which these handlers' try/catch reports as an endpoint failure, so the
 * symptom points at the provider rather than at the missing scope.
 *
 * `loadMcpServerForCaller` is the shared authorization read across those
 * endpoints and the easiest one to add unscoped, because nothing in its
 * signature says a scope is required. Assert the invariant over the whole file
 * rather than per endpoint, so a new caller is covered on the day it lands.
 */
describe('register-services MCP tenant unit of work', () => {
  const rawSource = readFileSync(join(__dirname, 'register-services.ts'), 'utf8');
  const codeOnly = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('keeps the MCP discovery and OAuth endpoints on the identity-only list', () => {
    // The invariant below only matters while these endpoints are denied an
    // automatic request transaction.
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain('mcp-servers/discover');
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain('mcp-servers/test-oauth');
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain('mcp-servers/oauth-start');
  });

  /** The service path of the `app.use()` registration a source offset falls in. */
  const owningServicePath = (offset: number): string | undefined => {
    let path: string | undefined;
    for (const registration of codeOnly.matchAll(/app\.use\(\s*'\/([^']+)'/g)) {
      if (registration.index > offset) break;
      path = registration[1];
    }
    return path;
  };

  it('opens a tenant scope around every identity-only loadMcpServerForCaller call', () => {
    const callSites = [...codeOnly.matchAll(/\bloadMcpServerForCaller\s*\(/g)];
    expect(callSites.length).toBeGreaterThan(0);

    const identityOnly = callSites.filter((match) => {
      const path = owningServicePath(match.index);
      return !!path && (TENANT_IDENTITY_ONLY_SERVICE_PATHS as readonly string[]).includes(path);
    });
    // Endpoints that are tenant-owned instead inherit the request transaction
    // and need no scope of their own, so they are not the subject here.
    expect(identityOnly.length).toBeGreaterThan(0);

    // A scope opened for this read still directly wraps it, although an outer
    // reservation/deadline fence may now add one nesting level. Matching on
    // the opener rather than on its arguments keeps this from breaking when a
    // local is renamed; the semicolon bound prevents an earlier unrelated
    // scope from satisfying the check.
    const unscoped = identityOnly.filter((match) => {
      const preceding = codeOnly.slice(Math.max(0, match.index - 320), match.index);
      return !/runInOAuthTenantScope\s*\([^;]*$/.test(preceding);
    });

    expect(
      unscoped.map((match) => `${owningServicePath(match.index)}: unscoped authorization read`)
    ).toEqual([]);
  });

  it('runs OAuth authority-change fanout in an explicit PostgreSQL RLS scope', () => {
    const hintSource = readFileSync(join(__dirname, 'utils/mcp-runtime-hints.ts'), 'utf8');
    expect(hintSource).toContain('runWithTenantContext(exactTenantId, work)');
    expect(hintSource).not.toContain('runWithTenantDatabaseScope(db, exactTenantId');
    const routeSource = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');
    expect(routeSource).toContain('withFreshTenantWrite(db, tenantId, () => visitor(task))');
    const completionStart = codeOnly.indexOf("app.use('/mcp-servers/oauth-complete'");
    const disconnectStart = codeOnly.indexOf(
      "app.use('/mcp-servers/oauth-disconnect'",
      completionStart
    );
    const statusStart = codeOnly.indexOf("app.use('/mcp-servers/oauth-status'", disconnectStart);
    const completion = codeOnly.slice(completionStart, disconnectStart);
    const disconnect = codeOnly.slice(disconnectStart, statusStart);

    expect(completion).toContain('scheduleMcpRuntimeHint(');
    expect(completion).toMatch(/runWithTenantDatabaseScope\(\s*db,\s*completedTenantId,/);
    expect(completion).toContain(
      'const completedTenantId = completedFlow.tenantId ?? tenantIdFromParams(params)'
    );
    expect(disconnect).toContain('scheduleMcpRuntimeHint(');
    expect(disconnect).toMatch(/scheduleMcpRuntimeHint\(\s*db,\s*tenantId,/);
  });

  it('loads the completed OAuth server only inside the authoritative tenant scope', () => {
    const completionStart = codeOnly.indexOf("app.use('/mcp-servers/oauth-complete'");
    const disconnectStart = codeOnly.indexOf(
      "app.use('/mcp-servers/oauth-disconnect'",
      completionStart
    );
    const completion = codeOnly.slice(completionStart, disconnectStart);
    const lookup = completion.indexOf('new MCPServerRepository(tenantDb).findById(');
    const explicitScope = completion.lastIndexOf('runWithTenantDatabaseScope(', lookup);

    expect(completionStart).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(-1);
    expect(explicitScope).toBeGreaterThan(-1);
    expect(explicitScope).toBeLessThan(lookup);
    expect(completion.slice(explicitScope, lookup)).not.toContain('MCPServerRepository(db)');
  });

  it('gates automatic runtime recovery before all task fanout in direct modes', () => {
    const routeSource = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');
    for (const marker of [
      'const signalSessionMcpAuthorityChange = async',
      ').signalMcpServerAuthorityChange = async',
      ').signalMcpPrincipalAuthorityChange = async',
    ]) {
      const start = routeSource.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const entry = routeSource.slice(start, start + 500);
      expect(entry).toContain(
        'withFreshTenantWrite(db, tenantId, () => isMcpRuntimeRecoveryEnabled(db))'
      );
    }
  });

  it('uses captured removal targets without a second active-task scan', () => {
    const routeSource = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');
    const hookSource = readFileSync(join(__dirname, 'register-hooks.ts'), 'utf8');
    const start = routeSource.indexOf(').signalMcpServerAuthorityChange = async');
    const end = routeSource.indexOf(').signalMcpPrincipalAuthorityChange = async', start);
    const body = routeSource.slice(start, end);
    const exactStart = body.indexOf('if (exactTasks)');
    const scanStart = body.indexOf('await visitActiveMcpTasks(', exactStart);
    const exactTargetPath = body.slice(exactStart, scanStart);

    expect(exactTargetPath).not.toContain('visitActiveMcpTasks');
    expect(exactStart).toBeGreaterThan(-1);
    expect(exactStart).toBeLessThan(scanStart);

    const captureStart = hookSource.indexOf('const captureMcpRemovalTargets = async');
    const captureEntry = hookSource.slice(captureStart, captureStart + 500);
    expect(captureEntry).toContain('if (!(await isMcpRuntimeRecoveryEnabled(db)))');
    expect(captureEntry.indexOf('isMcpRuntimeRecoveryEnabled')).toBeLessThan(
      captureEntry.indexOf("app.service('mcp-servers').get")
    );
  });

  it('authorizes reconnect before loading the requested task', () => {
    const routeSource = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');
    const start = routeSource.indexOf("'/tasks/:id/mcp-reconnect'");
    const end = routeSource.indexOf("'/mcp-egress/rollout'", start);
    const body = routeSource.slice(start, end);

    expect(body.indexOf('authorizeMcpReconnectRoute')).toBeGreaterThan(-1);
    expect(body.indexOf('authorizeMcpReconnectRoute')).toBeLessThan(
      body.indexOf('new TaskRepository(db).findById')
    );
  });

  it('fences refresh projection and acknowledgement by generation plus request identity', () => {
    const routeSource = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');
    const projectionStart = routeSource.indexOf("'/tasks/:id/mcp-reprojection'");
    const validationStart = routeSource.indexOf("'/tasks/:id/mcp-reprojection-validate'");
    const resultStart = routeSource.indexOf("'/tasks/:id/mcp-refresh-result'");
    const reconnectStart = routeSource.indexOf("'/tasks/:id/mcp-reconnect'");
    const projection = routeSource.slice(projectionStart, validationStart);
    const validation = routeSource.slice(validationStart, resultStart);
    const result = routeSource.slice(resultStart, reconnectStart);
    const taskRepositorySource = readFileSync(
      join(__dirname, '../../../packages/core/src/db/repositories/tasks.ts'),
      'utf8'
    );
    const claimStart = taskRepositorySource.indexOf('async claimMCPReprojection');
    const validationRepoStart = taskRepositorySource.indexOf(
      'async validateMCPReprojectionClaim',
      claimStart
    );
    const settleStart = taskRepositorySource.indexOf('async settleMCPReprojection', claimStart);
    const clearStart = taskRepositorySource.indexOf('async clearMCPRecovery', settleStart);
    const claim = taskRepositorySource.slice(claimStart, validationRepoStart);
    const durableValidation = taskRepositorySource.slice(validationRepoStart, settleStart);
    const settlement = taskRepositorySource.slice(settleStart, clearStart);

    expect(projection).toContain('Number.isSafeInteger(data.expected_generation)');
    expect(claim).toContain('recovery.generation !== input.expectedGeneration');
    expect(claim).toContain('recovery.request_id !== input.requestId');
    expect(validation).toContain('validateMCPReprojectionClaim');
    expect(durableValidation).toContain('claim?.request_id === input.requestId');
    expect(durableValidation).toContain('claim.recovery_generation === input.expectedGeneration');
    expect(result).toContain('Number.isSafeInteger(data.expected_generation)');
    expect(result).toContain('settleMCPReprojection');
    expect(settlement).toContain('recovery.generation !== input.expectedGeneration');
    expect(settlement).toContain('recovery.request_id !== input.requestId');
  });
});
