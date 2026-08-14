import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Architecture guard for the streamed branch-file download plane.
 *
 * The regression this protects against (#2128) had two halves, and a fix can
 * regress into either one:
 *
 *   1. bulk file bytes riding the executor's JSON result over Socket.IO, which
 *      caps frames and made files over ~1 MB undownloadable; and
 *   2. "fixing" that by giving the daemon its own read access to branch
 *      checkouts, which breaks the executor-owns-the-filesystem boundary.
 *
 * These assertions are source-level on purpose: the properties are about which
 * module is allowed to do what, which is exactly what a behavioural test of a
 * single handler cannot observe.
 */
describe('branch file download route boundary', () => {
  const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');

  const browserRoute = () => {
    const start = source.indexOf("'/branches/:branchId/files/download'");
    expect(start).toBeGreaterThan(0);
    return source.slice(start, source.indexOf("'/executor/files/downloads/", start));
  };

  const dataPlaneRoute = () => {
    const start = source.indexOf("'/executor/files/downloads/:downloadRef/content'");
    expect(start).toBeGreaterThan(0);
    return source.slice(start, source.indexOf('type UploadHttpRequest', start));
  };

  it('never opens the branch filesystem from the daemon', () => {
    // The daemon must delegate every byte to the executor. Any fs import here
    // would also require a new scripts/daemon-filesystem-exceptions.json entry.
    expect(source).not.toMatch(/from 'node:fs'/);
    expect(source).not.toMatch(/from 'node:fs\/promises'/);
    expect(source).not.toMatch(/createReadStream/);
  });

  it('authenticates and authorizes the browser request before opening a transfer', () => {
    const route = browserRoute();
    expect(route.indexOf('uploadAuthMiddleware')).toBeLessThan(route.indexOf('ensureMinimumRole'));
    expect(route.indexOf('ensureMinimumRole')).toBeLessThan(route.indexOf('.register('));
    // Branch RBAC 'view' is the same gate the /file service applies.
    expect(route).toContain('resolveBranchPermission');
    expect(route).toContain('PERMISSION_RANK.view');
    expect(route.indexOf('PERMISSION_RANK.view')).toBeLessThan(route.indexOf('.register('));
  });

  it('scopes the executor capability token to one action, ref, branch and tenant', () => {
    const route = browserRoute();
    expect(route).toContain("executor_action: 'files.download'");
    expect(route).toContain('executor_download_ref: transfer.ref');
    expect(route).toContain('executor_branch_id: resolved.branchId');
    // Minted inside a tenant scope so the service token carries tenant_id.
    expect(route).toMatch(/runWithTenantDatabaseScope\([\s\S]*generateScopedServiceToken/);
  });

  it('never puts the capability token in the URL it hands the executor', () => {
    const route = browserRoute();
    expect(route).toContain('downloadRef: transfer.ref');
    expect(route).not.toMatch(/downloads\/\$\{[^}]*sessionToken/);
  });

  it('releases the waiting browser when the executor command fails', () => {
    // Otherwise a missing or over-limit file hangs the request until the TTL.
    const route = browserRoute();
    expect(route).toMatch(/command\.then\(/);
    expect(route).toContain('transfer.cancel(');
    expect(route).toContain("res.once('close'");
  });

  it('verifies the executor claims before accepting a single byte', () => {
    const route = dataPlaneRoute();
    const firstClaimCheck = route.indexOf("claims?.type !== 'service'");
    expect(firstClaimCheck).toBeGreaterThan(0);
    expect(firstClaimCheck).toBeLessThan(route.indexOf('req.pipe('));
    expect(route).toContain("claims.executor_action !== 'files.download'");
    expect(route).toContain('claims.executor_download_ref !== downloadRef');
    expect(route).toContain("typeof claims.tenant_id !== 'string'");
  });

  it('claims the transfer with tenant and branch proof, not the ref alone', () => {
    const route = dataPlaneRoute();
    expect(route).toMatch(/claim\(downloadRef,\s*\{[\s\S]*tenantId:[\s\S]*branchId:/);
  });

  it('holds the stream to exactly its declared, authorized length', () => {
    const route = dataPlaneRoute();
    expect(route).toContain('transfer.scope.maxBytes');
    expect(route).toContain('received > size');
    expect(route).toContain('received === size');
  });

  it('reads the executor token from the Authorization header only', () => {
    const route = dataPlaneRoute();
    expect(route).toContain('req.headers.authorization');
    expect(route).toContain("authHeader.startsWith('Bearer ')");
    expect(route).not.toContain('req.query.token');
  });
});
