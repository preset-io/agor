import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_CAPABILITY_ISSUING_SERVICE_PATHS } from './utils/mcp-server-authorization.js';

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

  it('enumerates an authority owner for every public MCP capability-issuing socket service', () => {
    type CapabilityServicePath = (typeof MCP_CAPABILITY_ISSUING_SERVICE_PATHS)[number];
    const requiredAuthorityContracts = {
      // Reservation creation synchronously compares request and live socket
      // authority before minting the one-shot server nonce.
      'mcp-servers/oauth-browser-reservations': [/liveSocketAuthority\s*\(/],
      // Standalone OAuth start and JWT test requests carry a live, immutable
      // socket caller assertion through provider and database continuations.
      'mcp-servers/oauth-start': [
        /requestAuthorityAssertion\s*\(\s*params\s*\)/,
        /requestAuthority:\s*assertRequestAuthority/,
      ],
      'mcp-servers/test-jwt': [
        /requestAuthorityAssertion\s*\(\s*params\s*\)/,
        /assertCurrent:\s*assertRequestAuthority/,
      ],
      // Callback completion is owned by the claimed, tenant/user-bound
      // pending attempt rather than by a browser reservation.
      'mcp-servers/oauth-complete': [/assertPendingFlowStillAuthorized\s*\(\s*pendingFlow\s*\)/],
      // Refresh issuance is fenced by the exact durable grant generation and
      // rechecks the grant subject at its persistence choke point.
      'mcp-servers/oauth-refresh': [/observedRefreshVersion/, /refreshAndPersistToken\s*\(/],
      'mcp-servers/test-oauth': [/assertInitialRequestAuthority/, /runWithinOAuthAuthority\s*\(/],
      'mcp-servers/discover': [
        /assertCurrentRequestAuthority/,
        /createAuthorityGuardedMCPFetch\s*\(/,
      ],
    } satisfies Record<CapabilityServicePath, RegExp[]>;

    for (const path of MCP_CAPABILITY_ISSUING_SERVICE_PATHS) {
      const start = codeOnly.indexOf(`app.use('/${path}'`);
      const end = codeOnly.indexOf(`app.service('${path}').hooks`, start);
      expect(start, `${path} registration`).toBeGreaterThanOrEqual(0);
      expect(end, `${path} hook registration`).toBeGreaterThan(start);
      const serviceBody = codeOnly.slice(start, end);
      for (const contract of requiredAuthorityContracts[path]) {
        expect(serviceBody, `${path} authority contract ${contract}`).toMatch(contract);
      }
    }

    // The only bearer-returning service is not public: it independently
    // requires a trusted internal/service or session-executor capability.
    const authHeadersBody = codeOnly.slice(
      codeOnly.indexOf("app.use('/mcp-servers/oauth-auth-headers'"),
      codeOnly.indexOf("app.service('mcp-servers/oauth-auth-headers').hooks")
    );
    expect(authHeadersBody).toMatch(/shouldExposeMCPServerSecrets\s*\(\s*params\s*\)/);
    expect(authHeadersBody).toMatch(/shouldExposeMCPServerSecretsForSessionToken\s*\(/);

    // Keep the audit closed over the registered surface, not just today's
    // issuing list. Any newly registered OAuth/test/discovery service must be
    // classified here (and, when it issues capability, in the canonical role
    // floor list above) before this contract can pass.
    const nonIssuingOrInternal = [
      'mcp-servers/oauth-disconnect',
      'mcp-servers/oauth-status',
      'mcp-servers/oauth-attempt-status',
      'mcp-servers/oauth-auth-headers',
    ] as const;
    const registeredAuthServices = new Set(
      Array.from(
        codeOnly.matchAll(
          /app\.use\('\/(mcp-servers\/(?:oauth-[^']+|test-(?:jwt|oauth)|discover))'/g
        ),
        (match) => match[1]
      )
    );
    expect(registeredAuthServices).toEqual(
      new Set([...MCP_CAPABILITY_ISSUING_SERVICE_PATHS, ...nonIssuingOrInternal])
    );
  });

  it('uses durable hashed state claims on PostgreSQL and never broadcasts raw flow state', () => {
    expect(codeOnly).toMatch(/durableOAuthFlows\.claimForCallback\s*\(\s*state\s*\)/);
    expect(codeOnly).toMatch(/cacheToken:\s*false/);
    expect(codeOnly).toMatch(/attempt_id:\s*pendingFlow\.attemptId/);
    expect(codeOnly).toMatch(/reservation_token:\s*opts\.browserReservation\.reservationToken/);
    expect(codeOnly).toMatch(/caller_user_id:\s*opts\.browserReservation\.userId/);
    expect(codeOnly).toMatch(/awaitToken\s*&&\s*opts\.browserReservation\s*&&\s*app\.io/);
    expect(codeOnly).toMatch(
      /app\.io\.local\.to\s*\(\s*opts\.browserReservation\.socketId\s*\)\.emit\s*\(\s*['"]oauth:open_browser['"]/
    );
    expect(codeOnly).toMatch(/assertOAuthBrowserReservationStillCurrent/);
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
