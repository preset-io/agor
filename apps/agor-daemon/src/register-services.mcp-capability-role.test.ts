/**
 * That the caller floor runs, and that the writes which make a grant durable
 * carry the subject check.
 *
 * ## Why there is no longer a scan over endpoints
 *
 * Two earlier versions of this file tried to prove "no endpoint that mints a
 * credential is missing a guard" by searching `register-services.ts` for the
 * calls that mint. Both were wrong, in instructive ways:
 *
 * 1. The first hard-coded `oauth-auth-headers` as non-issuing. It calls
 *    `refreshAndPersistToken` twice. The test asserted the wrong answer and
 *    made the mistake look considered.
 * 2. The second derived the list by scanning, but matched the guard's *name*
 *    anywhere in the endpoint — which its own `const ... =` declaration
 *    satisfies — so deleting the refusal still passed.
 *
 * Fixing the second did not fix the shape. A scan over call sites enumerates
 * callers, and callers are the easy thing to add: `const mint =
 * refreshAndPersistToken`, an imported wrapper, or a helper defined outside the
 * block all mint without matching, and the endpoint is silently skipped. No
 * amount of pattern-tightening makes a survey into a proof.
 *
 * So the enforcement moved to the choke point instead. `persistOAuthToken` and
 * `refreshAndPersistToken` call `assertMcpGrantSubjectEntitled` themselves,
 * immediately before their write, so aliasing, wrapping and new endpoints are
 * all irrelevant — every route arrives at the same two functions. What is left
 * to check here is small and structural: that those two writes carry the check,
 * and that the caller floor is still wired.
 *
 * The caller floor is not redundant to that. It covers `discover` and
 * `test-jwt`, which reach a provider on a stored credential without persisting
 * a grant, and it gives the other four a fast, well-worded refusal instead of a
 * provider round-trip that fails at the write.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_CAPABILITY_ISSUING_SERVICE_PATHS } from './utils/mcp-server-authorization.js';

/** Strip comments so prose naming a helper cannot satisfy a structural check. */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('grant entitlement is enforced at the write', () => {
  const persistSource = codeOf(join(__dirname, 'oauth-cache.ts'));
  const refreshSource = codeOf(
    join(__dirname, '../../../packages/core/src/tools/mcp/oauth-refresh.ts')
  );

  it('checks the subject before persisting a completed flow', () => {
    const checkAt = persistSource.indexOf('assertMcpGrantSubjectEntitled(');
    const writeAt = persistSource.indexOf('saveToken(');
    expect(checkAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(checkAt, 'the check must precede the write').toBeLessThan(writeAt);
  });

  it('checks the subject before persisting every refreshed token', () => {
    // Both dialect paths persist: `completeClaimedRefresh` on PostgreSQL and
    // `saveToken` standalone. Neither may write without a preceding check.
    const writes = [...refreshSource.matchAll(/\b(completeClaimedRefresh|saveToken)\s*\(/g)];
    expect(writes.length).toBeGreaterThan(0);

    const unchecked = writes.filter((write) => {
      const before = refreshSource.slice(0, write.index);
      const checkAt = before.lastIndexOf('assertGrantSubjectForRefresh(');
      if (checkAt === -1) return true;
      // The check has to be in the same function as the write, not merely
      // earlier in the file. Nothing but a top-level `async function` opener
      // may sit between them.
      return /\nasync function /.test(before.slice(checkAt));
    });

    expect(unchecked.map((w) => `${w[1]} persists without a preceding subject check`)).toEqual([]);
  });

  it('resolves the subject from stored state, not from a caller argument', () => {
    // The point of moving the check inward: a caller cannot pre-satisfy it by
    // passing a flag. It reads the role itself.
    const guard = codeOf(
      join(__dirname, '../../../packages/core/src/tools/mcp/grant-entitlement.ts')
    );
    expect(guard).toContain('UsersRepository');
    expect(guard).toContain('isMcpGrantSubjectEntitled(');
  });
});

describe('standalone pending flows expire when taken, not only when swept', () => {
  const source = codeOf(join(__dirname, 'register-services.ts'));

  it('checks flow age between claiming a flow and using it', () => {
    // A TTL enforced only by the 60s sweeper is a TTL plus a jitter window, and
    // the reason that extra minute matters is that a demotion can land inside
    // it. Anchored on the assignment, which is where a callback or a manual
    // completion claims a flow — the sweeper's own delete is the expiry itself,
    // and the await-timeout's lookup discards rather than consumes.
    const takes = [...source.matchAll(/pendingFlow = pendingOAuthFlows\.get\(state\)/g)];
    expect(takes.length).toBeGreaterThan(0);

    const unchecked = takes.filter((take) => {
      // The window is "until the flow is acted on", not a character count: the
      // age has to be settled before anything else looks at the flow.
      const after = source.slice(take.index);
      const usedAt = after.indexOf('assertPendingFlowStillAuthorized(');
      const checkedAt = after.indexOf('isLocalOAuthFlowExpired(');
      return checkedAt === -1 || (usedAt > -1 && checkedAt > usedAt);
    });
    expect(unchecked.map(() => 'a flow is claimed and used without an age check')).toEqual([]);
  });

  it('shares one TTL between the sweeper and the take paths', () => {
    expect(source).toContain('LOCAL_OAUTH_FLOW_TTL_MS');
    // The sweeper must use the shared predicate rather than an inline literal,
    // so the two cannot drift apart.
    const sweeperAt = source.indexOf('const oauthCleanupTimer');
    const sweeper = source.slice(sweeperAt, sweeperAt + 700);
    expect(sweeper).toContain('isLocalOAuthFlowExpired(');
  });
});

describe('MCP caller floor wiring', () => {
  const source = codeOf(join(__dirname, 'register-services.ts'));

  it('never publishes caller-private OAuth browser reservation tokens', () => {
    expect(source).toContain(
      "app.service('mcp-servers/oauth-browser-reservations').publish?.(() => []);"
    );
  });

  it('applies the floor from the shipped registration helper', () => {
    expect(source).toContain('registerMcpCapabilityRoleFloor(app)');
  });

  it('applies it after the endpoints register their own auth hooks', () => {
    // Feathers appends, so ordering is what makes `ctx.requireAuth` run first
    // and lets the floor decide on an authenticated caller.
    const floorAt = source.indexOf('registerMcpCapabilityRoleFloor(app)');
    expect(floorAt).toBeGreaterThan(-1);
    for (const path of MCP_CAPABILITY_ISSUING_SERVICE_PATHS) {
      const hooksAt = source.indexOf(`app.service('${path}').hooks(`);
      expect(hooksAt, `${path} registers its own hooks`).toBeGreaterThan(-1);
      expect(hooksAt, `${path} hooks must register before the floor`).toBeLessThan(floorAt);
    }
  });

  it('mounts every path the floor names', () => {
    // A typo would otherwise fail silently — `app.service()` on an unmounted
    // path does not throw in a way this registration would notice.
    for (const path of MCP_CAPABILITY_ISSUING_SERVICE_PATHS) {
      expect(source, `${path} is not mounted`).toContain(`app.use('/${path}'`);
    }
  });

  it('re-checks the flow initiator ahead of SQLite and durable server authority', () => {
    // The callback gap was not the check being absent but unreachable: it sat
    // behind `if (!record) return`, which is every SQLite deployment.
    const guardAt = source.indexOf('const assertPendingFlowStillAuthorized');
    const body = source.slice(guardAt, guardAt + 5000);
    const initiatorAt = body.indexOf('assertFlowInitiatorStillEntitled(');
    const localAuthorityAt = body.indexOf('if (!record) {');
    expect(initiatorAt).toBeGreaterThan(-1);
    expect(localAuthorityAt).toBeGreaterThan(-1);
    expect(initiatorAt).toBeLessThan(localAuthorityAt);
    expect(body).toContain('savedServerAuthority');
    expect(body).toContain('localGrantBinding');
  });
});
