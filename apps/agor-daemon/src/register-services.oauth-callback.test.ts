import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression tests for the daemon-side MCP OAuth callback URL.
 *
 * Background: a previous bug had `apps/agor-daemon/src/register-services.ts`
 * routing some OAuth flows (Settings UI Discover, Test OAuth → Start Browser
 * Flow) through `performMCPOAuthFlow()` from `@agor/core/tools/mcp/...`. That
 * helper spins up a `127.0.0.1:<random>` HTTP listener and uses it as the
 * OAuth `redirect_uri`. Upstream OAuth providers (Notion, Linear, etc.) then
 * send the redirect to the END USER'S BROWSER, which generally cannot reach
 * the daemon's `127.0.0.1` — symptom: per-user "OAuth login redirected me to
 * localhost" failures for any user not running on the daemon host.
 *
 * The fix funnels every daemon OAuth path through `startTwoPhaseMCPOAuthFlow`,
 * which builds the `redirect_uri` from `requirePublicBaseUrl()` —
 * `<daemon base_url>/mcp-servers/oauth-callback` — never from `localhost` or
 * `127.0.0.1`.
 *
 * These structural assertions are intentionally coarse: they prevent the
 * specific regression of any new daemon code re-introducing
 * `performMCPOAuthFlow` or hand-rolling a `127.0.0.1` callback URL.
 */
describe('register-services OAuth callback URL regression', () => {
  const rawSource = readFileSync(join(__dirname, 'register-services.ts'), 'utf8');

  /**
   * Strip comments and string literals so the structural checks below can't be
   * fooled by (a) explanatory prose mentioning the old 127.0.0.1 behavior or
   * (b) unrelated `http://localhost:` strings (e.g. the UI dev URL, which has
   * nothing to do with OAuth).
   */
  const codeOnly = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (keep `://`)

  it('never calls performMCPOAuthFlow from the daemon', () => {
    // The CLI helper is now documented as CLI-only. Daemon code MUST go
    // through startTwoPhaseMCPOAuthFlow + the daemon-side oauth-callback
    // handler so the redirect_uri is the daemon's public base URL.
    expect(codeOnly).not.toMatch(/\bperformMCPOAuthFlow\s*\(/);
  });

  it('never constructs an OAuth redirect URI pointing at 127.0.0.1 or localhost', () => {
    // Catch hand-rolled redirect URIs in any new code path that bypasses
    // requirePublicBaseUrl(). Narrow the check to `redirect`-adjacent usage
    // so it can't be tripped by unrelated hosts (e.g. `http://localhost:UI_PORT`).
    const redirectContextWindows = codeOnly.match(/.{0,80}redirect.{0,160}/gi) || [];
    for (const window of redirectContextWindows) {
      expect(window).not.toMatch(/127\.0\.0\.1/);
      expect(window).not.toMatch(/http:\/\/localhost/);
    }
  });

  it('builds the OAuth redirect URI from the public base URL', () => {
    // startTwoPhaseMCPOAuthFlow is the single entry point and must use
    // requirePublicBaseUrl() (not getBaseUrl(), which silently falls back
    // to localhost in dev).
    expect(codeOnly).toMatch(/requirePublicBaseUrl\s*\(/);
    expect(codeOnly).toMatch(/['"]\/mcp-servers\/oauth-callback['"]/);
  });

  it('preserves tenant scope across unauthenticated OAuth callbacks', () => {
    // Browser redirects to /mcp-servers/oauth-callback do not carry the
    // originating Feathers auth params or tenant headers, so the pending OAuth
    // state must capture tenant_id at flow start and re-enter that DB scope
    // before persisting user_mcp_oauth_tokens or backfilling mcp_servers auth.
    expect(codeOnly).toMatch(/tenantId\?\s*:\s*string/);
    expect(codeOnly).toMatch(/tenantId:\s*opts\.tenantId\s*\?\?\s*getCurrentTenantId\s*\(\s*\)/);
    expect(codeOnly).toMatch(/runInOAuthTenantWriteScope\s*\(\s*db,\s*pendingFlow\.tenantId/);
    expect(codeOnly).toMatch(/Missing tenant context for MCP OAuth callback/);
    expect(codeOnly).toMatch(/OAuth flow belongs to a different tenant/);
  });

  it('uses durable hashed state claims on PostgreSQL and never broadcasts raw flow state', () => {
    expect(codeOnly).toMatch(/durableOAuthFlows\.claimForCallback\s*\(\s*state\s*\)/);
    expect(codeOnly).toMatch(/cacheToken:\s*false/);
    expect(codeOnly).toMatch(/attempt_id:\s*pendingFlow\.attemptId/);
    expect(codeOnly).toMatch(
      /app\.io\.local\.to\s*\(\s*opts\.socketId\s*\)\.emit\s*\(\s*['"]oauth:open_browser['"]/
    );
    expect(codeOnly).not.toMatch(/app\.io\.emit\s*\(\s*['"]oauth:open_browser['"]/);
    expect(codeOnly).not.toMatch(/emit\s*\(\s*['"]oauth:completed['"][\s\S]{0,300}\bstate\b/);
  });

  it('keeps provider capability material out of callback logs', () => {
    const callbackBody = rawSource.slice(
      rawSource.indexOf('const oauthCallbackHandler'),
      rawSource.indexOf("app.use('/mcp-servers',")
    );
    const loggedExpressions = [...callbackBody.matchAll(/console\.(?:log|warn|error)\(([^;]+)\)/g)]
      .map((match) => match[1])
      .join('\n');
    expect(loggedExpressions).not.toMatch(/\b(?:code|state|tokenResponse|pendingFlow\.context)\b/);
  });

  it('validates callback issuer before consuming success or provider-error state', () => {
    const callbackBody = rawSource.slice(
      rawSource.indexOf('const oauthCallbackHandler'),
      rawSource.indexOf("app.use('/mcp-servers',")
    );
    const inspectIndex = callbackBody.indexOf('inspectForCallback(state)');
    const validateIndex = callbackBody.indexOf('validateMCPOAuthCallbackIssuer');
    const providerErrorIndex = callbackBody.indexOf('if (error)');
    const failIndex = callbackBody.indexOf('failPendingCallback');
    const claimIndex = callbackBody.indexOf('claimForCallback(state)');

    expect(inspectIndex).toBeGreaterThanOrEqual(0);
    expect(validateIndex).toBeGreaterThan(inspectIndex);
    expect(providerErrorIndex).toBeGreaterThan(validateIndex);
    expect(failIndex).toBeGreaterThan(providerErrorIndex);
    expect(claimIndex).toBeGreaterThan(validateIndex);
  });

  it('uses one phase-aware failure classifier for callback and manual completion', () => {
    const classifications = codeOnly.match(/classifyMCPOAuthCompletionFailure\s*\(/g) ?? [];
    expect(classifications).toHaveLength(2);
    expect(codeOnly).toMatch(/durableOAuthFlows!\.finish[\s\S]{0,180}classification\.status/);
    expect(codeOnly.match(/classification\.failureCode/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
