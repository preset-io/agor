/**
 * That the guards run, and that no endpoint which mints a credential escapes
 * being guarded by one of them.
 *
 * The first version of this file asserted a hand-written list of "non-issuing"
 * paths, which is how it managed to certify `oauth-auth-headers` as harmless
 * while that endpoint called `refreshAndPersistToken` twice. A test that
 * restates a decision cannot detect the decision being wrong; it just makes the
 * mistake look considered. So the classification here is *derived* — the source
 * is searched for the functions that actually mint or store a credential, and
 * every endpoint containing one must be covered by a named guard that the same
 * endpoint demonstrably carries.
 *
 * Source-level for the same reason the other `register-services.*` tests are:
 * standing up the whole registration needs a database, a config, an executor
 * and a socket server, none of which this is about. The behaviour of each guard
 * is driven for real in `services/mcp-capability-role.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_CAPABILITY_ISSUING_SERVICE_PATHS } from './utils/mcp-server-authorization.js';

/**
 * Calls that obtain, exchange, or persist a credential. An endpoint containing
 * one of these is issuing capability, whatever its name suggests.
 */
const CREDENTIAL_MINTING_CALLS = [
  'refreshAndPersistToken(',
  'persistOAuthToken(',
  'persistOAuthTokenForPendingFlow(',
  'completeMCPOAuthFlow(',
  'startTwoPhaseMCPOAuthFlow(',
  'startTwoPhaseMCPOAuthFlowAndAwaitToken(',
];

/**
 * Endpoints that mint but cannot be guarded by flooring their caller, with the
 * guard that covers them instead. The guard's name must appear in the
 * endpoint's own source, so an exemption cannot outlive the guard it claims.
 */
const GUARDED_BY_SUBJECT_STANDING: Record<string, string> = {
  // The provider's browser redirect. No caller, no session — only `state` — so
  // the standing checked is the recorded initiator's.
  'mcp-servers/oauth-callback': 'assertPendingFlowStillAuthorized',
  // Called by an executor under a session token; the standing checked is the
  // grant owner's.
  'mcp-servers/oauth-auth-headers': 'isPerUserGrantOwnerEntitled',
};

describe('MCP capability guards', () => {
  const rawSource = readFileSync(join(__dirname, 'register-services.ts'), 'utf8');
  // Strip comments so prose naming a helper cannot satisfy any check below.
  const codeOnly = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  /**
   * The source of each `/mcp-servers/*` endpoint, from its `app.use(` to the
   * next one. `oauth-callback` is not an `app.use` route — it is an express
   * handler returned from this module — so it is sliced from its own function.
   */
  const endpointBlocks = (): Map<string, string> => {
    const blocks = new Map<string, string>();
    const mounts = [...codeOnly.matchAll(/app\.use\(\s*'\/(mcp-servers[^']*)'/g)];
    mounts.forEach((mount, index) => {
      const end = index + 1 < mounts.length ? mounts[index + 1].index : codeOnly.length;
      blocks.set(mount[1], codeOnly.slice(mount.index, end));
    });
    const callbackAt = codeOnly.indexOf('const oauthCallbackHandler');
    if (callbackAt > -1) {
      const rest = codeOnly.slice(callbackAt);
      const next = rest.slice(1).search(/\n {2}(const|async function) /);
      blocks.set('mcp-servers/oauth-callback', next === -1 ? rest : rest.slice(0, next + 1));
    }
    return blocks;
  };

  it('finds the endpoints it means to classify (sanity)', () => {
    const blocks = endpointBlocks();
    expect(blocks.size).toBeGreaterThan(5);
    expect([...blocks.keys()]).toEqual(expect.arrayContaining(['mcp-servers/oauth-callback']));
  });

  /**
   * The offset of the first *call* to `name` in `block`, or -1.
   *
   * A call, not a mention: an earlier draft of this test asked whether the
   * guard's name appeared anywhere in the endpoint, which the guard's own
   * `const ... =` declaration satisfies. Deleting the refusal while leaving the
   * declaration behind therefore passed — the test certified a guard that no
   * longer ran. Requiring `name(` excludes the declaration, whose identifier is
   * followed by `=` rather than `(`.
   */
  const firstCallAt = (block: string, name: string): number =>
    block.search(new RegExp(`\\b${name}\\s*\\(`));

  it('guards every endpoint that mints a credential, before it mints', () => {
    const unguarded: string[] = [];
    for (const [path, block] of endpointBlocks()) {
      const mints = CREDENTIAL_MINTING_CALLS.filter((call) => block.includes(call));
      if (mints.length === 0) continue;
      if ((MCP_CAPABILITY_ISSUING_SERVICE_PATHS as readonly string[]).includes(path)) continue;

      const subjectGuard = GUARDED_BY_SUBJECT_STANDING[path];
      const guardAt = subjectGuard ? firstCallAt(block, subjectGuard) : -1;
      const firstMintAt = Math.min(
        ...mints.map((call) => block.indexOf(call)).filter((at) => at > -1)
      );

      if (guardAt > -1 && guardAt < firstMintAt) continue;

      unguarded.push(
        !subjectGuard
          ? `${path} calls ${mints.join(', ')} but carries no role guard`
          : guardAt === -1
            ? `${path} claims ${subjectGuard}, which its source never calls`
            : `${path} calls ${subjectGuard} only after it has already minted`
      );
    }

    // This is the assertion that would have caught `oauth-auth-headers`.
    expect(unguarded).toEqual([]);
  });

  it('keeps the caller floor to endpoints a caller actually drives', () => {
    // The converse mistake: flooring the caller on an endpoint the executor
    // drives would refuse a robot for having no role.
    for (const path of Object.keys(GUARDED_BY_SUBJECT_STANDING)) {
      expect(MCP_CAPABILITY_ISSUING_SERVICE_PATHS as readonly string[]).not.toContain(path);
    }
  });

  it('applies the caller floor from the shipped registration helper', () => {
    // The helper, not a loop copied into this file — a copy is what drifts.
    expect(codeOnly).toContain('registerMcpCapabilityRoleFloor(app)');
  });

  it('applies it after the endpoints register their own auth hooks', () => {
    // Feathers appends, so ordering is what makes `ctx.requireAuth` run first
    // and lets the floor decide on an authenticated caller.
    const floorAt = codeOnly.indexOf('registerMcpCapabilityRoleFloor(app)');
    expect(floorAt).toBeGreaterThan(-1);
    for (const path of MCP_CAPABILITY_ISSUING_SERVICE_PATHS) {
      const hooksAt = codeOnly.indexOf(`app.service('${path}').hooks(`);
      expect(hooksAt, `${path} registers its own hooks`).toBeGreaterThan(-1);
      expect(hooksAt, `${path} hooks must register before the floor`).toBeLessThan(floorAt);
    }
  });

  it('mounts every path the floor names', () => {
    // A typo in the list would otherwise fail silently — `app.service()` on an
    // unmounted path does not throw in a way this registration would notice.
    for (const path of MCP_CAPABILITY_ISSUING_SERVICE_PATHS) {
      expect(codeOnly, `${path} is not mounted`).toContain(`app.use('/${path}'`);
    }
  });

  it('re-checks the flow initiator ahead of the durable-only branch', () => {
    // The gap was not the check being absent but its being unreachable: it sat
    // behind `if (!record) return`, which is every SQLite deployment.
    const guardAt = codeOnly.indexOf('const assertPendingFlowStillAuthorized');
    const body = codeOnly.slice(guardAt, guardAt + 1200);
    const initiatorAt = body.indexOf('assertFlowInitiatorStillEntitled(');
    const durableReturnAt = body.indexOf('if (!record) return;');
    expect(initiatorAt).toBeGreaterThan(-1);
    expect(durableReturnAt).toBeGreaterThan(-1);
    expect(initiatorAt).toBeLessThan(durableReturnAt);
  });
});
