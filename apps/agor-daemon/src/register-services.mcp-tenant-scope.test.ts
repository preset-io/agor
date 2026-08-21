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
});
