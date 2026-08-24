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

  it('keeps saved-server OAuth authoritative and DCR credentials request-local', () => {
    const oauthStartBody = codeOnly.slice(
      codeOnly.indexOf("app.use('/mcp-servers/oauth-start'"),
      codeOnly.indexOf("app.service('mcp-servers/oauth-start').hooks")
    );
    // The saved row is loaded inside the tenant scope and by the supplied id,
    // through the loader that also decides whether this caller may see it —
    // `loadMcpServerForCaller` is `findById` plus that check, so pinning it
    // keeps the authority this test is named for and adds the caller to it.
    // `params` is part of the pin: without it the lookup would resolve any
    // tenant row, and a member could borrow another user's OAuth client.
    expect(oauthStartBody).toMatch(
      /runInOAuthTenantScope\s*\([\s\S]*loadMcpServerForCaller\s*\(\s*db,\s*savedServerId,\s*params/
    );
    expect(oauthStartBody).toMatch(/effectiveMcpUrl\s*=\s*savedServer\?\.url\s*\?\?/);
    expect(oauthStartBody).toMatch(/clientId:\s*savedServer\s*\?\s*clientIdFromConfig/);
    expect(codeOnly).toMatch(/reuseDynamicClientRegistration:\s*false/);
  });

  it('binds durable pending flows to the authoritative compatibility policy', () => {
    const flowHelper = codeOnly.slice(
      codeOnly.indexOf('async function startTwoPhaseMCPOAuthFlowInternal'),
      codeOnly.indexOf('const tenantIdFromParams')
    );
    expect(flowHelper).toMatch(/resolveMCPOAuthCompatibilityPolicy\s*\(\s*server\s*\)/);
    expect(flowHelper).toMatch(/effectiveClientId\s*=\s*server\.auth\.oauth_client_id/);
    expect(flowHelper).toMatch(/effectiveCompatibilityMode\s*=\s*compatibilityPolicy\.mode/);
    expect(flowHelper).toMatch(/compatibilityMode:\s*context\.compatibilityMode/);

    const callbackAuthority = codeOnly.slice(
      codeOnly.indexOf('const assertPendingFlowStillAuthorized'),
      codeOnly.indexOf('const persistOAuthTokenForPendingFlow')
    );
    expect(callbackAuthority).toMatch(
      /compatibilityPolicy\?\.mode\s*!==\s*pendingFlow\.context\.compatibilityMode/
    );
    expect(callbackAuthority).toMatch(
      /compatibilityMode:\s*pendingFlow\.context\.compatibilityMode/
    );
  });

  it('validates test-oauth transient policy before outbound work and reloads saved authority', () => {
    const testOauth = codeOnly.slice(
      codeOnly.indexOf("app.use('/mcp-servers/test-oauth'"),
      codeOnly.indexOf("app.service('mcp-servers/test-oauth').hooks")
    );
    expect(testOauth.indexOf('assertPublicMCPOAuthCompatibilityMode')).toBeLessThan(
      testOauth.indexOf('oauthFetch(')
    );
    expect(testOauth).toMatch(/effectiveMcpUrl\s*=\s*authoritativeServer\?\.url/);
    expect(testOauth).toMatch(/compatibilityPolicy\?\.mode\s*\?\?/);
    expect(testOauth).toMatch(/effectiveClientId\s*=\s*authoritativeServer/);
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

  it('persists the grant and notifies the initiating UI before serving the closing page', () => {
    const callbackBody = rawSource.slice(
      rawSource.indexOf('const oauthCallbackHandler'),
      rawSource.indexOf("app.use('/mcp-servers',")
    );
    const successBody = callbackBody.slice(
      callbackBody.indexOf(
        "persistOAuthTokenForPendingFlow(tokenResponse, pendingFlow, 'OAuth Callback')"
      ),
      callbackBody.indexOf('} catch (innerErr)')
    );

    const persistIndex = successBody.indexOf('persistOAuthTokenForPendingFlow');
    const notifyIndex = successBody.indexOf('emitOAuthCompletion(pendingFlow, true)');
    const resolveIndex = successBody.indexOf('pendingFlow.tokenResolve?.(tokenResponse)');
    const renderIndex = successBody.indexOf('sendOAuthResultPage(res, true');

    expect(persistIndex).toBeGreaterThanOrEqual(0);
    expect(notifyIndex).toBeGreaterThan(persistIndex);
    expect(resolveIndex).toBeGreaterThan(notifyIndex);
    expect(renderIndex).toBeGreaterThan(resolveIndex);
  });

  it('marks callback responses no-store and renders denied/error states without success mode', () => {
    const callbackBody = codeOnly.slice(
      codeOnly.indexOf('const oauthCallbackHandler'),
      codeOnly.indexOf("app.use('/mcp-servers',")
    );

    expect(callbackBody).toMatch(
      /setHeader\s*\(\s*['"]Cache-Control['"]\s*,\s*['"]no-store['"]\s*\)/
    );
    expect(callbackBody).toMatch(
      /if\s*\(\s*error\s*\)[\s\S]*sendOAuthResultPage\s*\(\s*res\s*,\s*false/
    );
    expect(callbackBody).toMatch(
      /if\s*\(\s*!code\s*\|\|\s*!state\s*\)[\s\S]*sendOAuthResultPage\s*\(\s*res\s*,\s*false/
    );
  });

  it('uses one phase-aware failure classifier for callback and manual completion', () => {
    const classifications = codeOnly.match(/classifyMCPOAuthCompletionFailure\s*\(/g) ?? [];
    expect(classifications).toHaveLength(2);
    expect(codeOnly).toMatch(/durableOAuthFlows!\.finish[\s\S]{0,180}classification\.status/);
    expect(codeOnly.match(/classification\.failureCode/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
