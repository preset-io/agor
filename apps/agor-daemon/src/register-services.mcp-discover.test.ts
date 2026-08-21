import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural regression check for the `/mcp-servers/discover` endpoint.
 *
 * Behavior of the template resolution itself is covered in
 * `utils/mcp-probe-templates.test.ts` (real input/output assertions).
 * This file only protects the *wiring*: the discover endpoint MUST call
 * `resolveProbeServerTemplates`, and it MUST do so before
 * `resolveMCPAuthHeaders` consumes the auth config (otherwise the
 * resolution is dead code that runs after the headers are built).
 *
 * Same source-level pattern as `register-services.oauth-callback.test.ts`:
 * cheap, no Feathers/DB scaffolding, scoped to the discover block so
 * unrelated edits elsewhere in `register-services.ts` don't trigger it.
 */
describe('register-services /mcp-servers/discover wiring', () => {
  const rawSource = readFileSync(join(__dirname, 'register-services.ts'), 'utf8');

  // Strip block + line comments so prose explaining the bug can't satisfy
  // or fool the structural checks. Keep `://` so URLs survive.
  const codeOnly = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  // Slice the discover endpoint body. We anchor on the unique
  // `app.use('/mcp-servers/discover'` registration and stop at the next
  // top-level `app.use(` or `app.service(` so the assertions stay scoped
  // to the endpoint and don't drift into unrelated code.
  const discoverStart = codeOnly.indexOf("app.use('/mcp-servers/discover'");
  const afterDiscover = codeOnly.slice(discoverStart + 1);
  const nextAppUse = afterDiscover.search(/app\.(use|service)\s*\(/);
  const discoverBlock =
    discoverStart === -1
      ? ''
      : nextAppUse === -1
        ? afterDiscover
        : afterDiscover.slice(0, nextAppUse);

  it('registers the discover endpoint (sanity)', () => {
    expect(discoverStart).toBeGreaterThan(-1);
    expect(discoverBlock.length).toBeGreaterThan(0);
  });

  it('uses the same caller visibility gate for saved server IDs', () => {
    expect(discoverBlock).toContain('loadMcpServerForCaller');
  });

  it('captures and persists only inside explicit tenant database boundaries', () => {
    // Discover is a tenant-identity-only service (see
    // TENANT_IDENTITY_ONLY_SERVICE_PATHS): it performs network I/O, so it
    // never inherits a request-long tenant transaction and each database
    // touch must open its own short scope. An unscoped one throws against a
    // scope-requiring handle, which this endpoint's try/catch would report as
    // a discovery failure — after the outbound probe already ran.
    //
    // The authority helper accepts only a TenantScopedDatabase and the
    // persistence helper additionally rejects a non-transactional scope.
    // Reaching a repository directly from here would skip both boundaries.
    expect(discoverBlock).toContain('persistDiscoveredMCPCapabilities(');
    expect(discoverBlock).toContain('runWithTenantDatabaseScope(');
    expect(discoverBlock).toContain('runWithTenantDatabaseTransaction(');
    expect(discoverBlock).not.toMatch(/\bMCPServerRepository\s*\(/);
  });

  it('captures saved-row authority before provider I/O and presents that stamp at persistence', () => {
    const capture = discoverBlock.indexOf('captureMCPDiscoveryAuthority(');
    const firstOutbound = discoverBlock.indexOf('resolveMCPAuthHeaders(');
    const persist = discoverBlock.indexOf('persistDiscoveredMCPCapabilities(');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(firstOutbound);
    expect(persist).toBeGreaterThan(firstOutbound);
    expect(discoverBlock.slice(persist, persist + 180)).toContain('discoveryAuthority');
  });

  it('emits the user-targeted Marketplace invalidation after durable persistence', () => {
    const persist = discoverBlock.indexOf('persistDiscoveredMCPCapabilities(');
    const invalidate = discoverBlock.indexOf('emitMarketplaceInvalidation(');
    expect(persist).toBeGreaterThan(-1);
    expect(invalidate).toBeGreaterThan(persist);
    expect(discoverBlock.slice(invalidate, invalidate + 260)).toContain(
      'authoritativeServer?.owner_user_id'
    );
  });

  it('calls resolveProbeServerTemplates before resolveMCPAuthHeaders', () => {
    const probeIdx = discoverBlock.search(/\bresolveProbeServerTemplates\s*\(/);
    const headersIdx = discoverBlock.search(/\bresolveMCPAuthHeaders\s*\(/);

    // Both must be present.
    expect(probeIdx).toBeGreaterThan(-1);
    expect(headersIdx).toBeGreaterThan(-1);

    // Resolution must happen first — otherwise the headers are built from
    // unresolved {{ user.env.X }} strings.
    expect(probeIdx).toBeLessThan(headersIdx);
  });

  it('routes JWT and OAuth credentials through hosted-safe outbound/cache options', () => {
    expect(discoverBlock).toContain('allowLocalhostHttp: !postgresOAuthDeployment');
    expect(discoverBlock).toContain('cacheNamespace:');
    expect(discoverBlock).toContain('disableProcessTokenCache: !!durableOAuthFlows');
  });

  it('rejects transient compatibility values and uses the durable row for grant-producing discovery', () => {
    const validationIdx = discoverBlock.indexOf('assertPublicMCPOAuthCompatibilityMode(data.auth)');
    const firstOutboundIdx = discoverBlock.indexOf('oauthFetch(');
    expect(validationIdx).toBeGreaterThan(-1);
    expect(validationIdx).toBeLessThan(firstOutboundIdx);
    expect(discoverBlock).toMatch(/serverConfig\s*=\s*\{[\s\S]*url:\s*server\.url/);
    expect(discoverBlock).not.toContain('restoreRedactedMCPAuthSecrets');
    expect(discoverBlock).toMatch(
      /resolveMCPOAuthCompatibilityPolicy\s*\(\s*authoritativeServer\s*\?\?/
    );
  });

  it('skips pre-resolution URL validation for templated URLs', () => {
    // `new URL("https://{{ user.env.HOST }}/mcp")` throws because of the
    // whitespace inside `{{ }}`, and `new URL("{{ user.env.MCP_URL }}")`
    // throws because there is no scheme. So pre-resolution `validateUrl()`
    // calls MUST be guarded by an `isTemplated` check, otherwise URL
    // templates get rejected before they can be resolved (the original
    // shape of the bug this PR is fixing, but for the URL field).
    expect(discoverBlock).toMatch(/\bconst\s+isTemplated\s*=/);

    // Both pre-resolution validation sites (inline `data.url` and saved
    // `server.url`) must be inside an `!isTemplated(...)` guard.
    expect(discoverBlock).toMatch(/!isTemplated\(\s*data\.url/);
    expect(discoverBlock).toMatch(/!isTemplated\(\s*server\.url/);

    // The post-resolution recheck still runs for templated URLs.
    expect(discoverBlock).toMatch(/isTemplated\(\s*serverConfig\.url/);
  });
});
