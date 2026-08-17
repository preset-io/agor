/**
 * That the role floor runs, and that no `/mcp-servers/*` endpoint escapes the
 * question.
 *
 * `mcp-capability-role.test.ts` proves the floor is correct by driving the real
 * registration against a real app. A floor that is correct and a floor that
 * runs are different claims, and the second one is what this file is for: the
 * endpoints live in ~1,800 lines of `register-services.ts`, so the failure mode
 * is a new one landing beside them and simply never being classified.
 *
 * Source-level for the same reason the other `register-services.*` tests are —
 * standing up the whole registration needs a database, a config, an executor
 * and a socket server, none of which this is about.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_CAPABILITY_ISSUING_SERVICE_PATHS } from './utils/mcp-server-authorization.js';

/**
 * Every other `/mcp-servers/*` endpoint, with the reason it issues no
 * capability. Adding an endpoint means adding it here or to
 * `MCP_CAPABILITY_ISSUING_SERVICE_PATHS`; the last assertion refuses to let it
 * be neither.
 */
const NON_ISSUING_MCP_SERVICE_PATHS: Record<string, string> = {
  // Revocation, which must not be refused to the user whose grant it is.
  'mcp-servers/oauth-disconnect': 'drops a grant rather than issuing one',
  // Reads of the caller's own state.
  'mcp-servers/oauth-status': "reads the caller's own authenticated-server list",
  'mcp-servers/oauth-attempt-status': "reads the caller's own pending attempt",
  // Hands the executor a bearer for a grant that already exists, under a
  // session token or service account rather than a user role.
  'mcp-servers/oauth-auth-headers': 'vends an already-issued grant to the executor',
  // Configuration CRUD, already floored by `authorizeMcpServerWrite`.
  'mcp-servers': 'goes through authorizeMcpServerWrite',
};

describe('MCP capability role floor wiring', () => {
  const rawSource = readFileSync(join(__dirname, 'register-services.ts'), 'utf8');
  // Strip comments so prose naming the helper cannot satisfy the check.
  const codeOnly = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('applies the floor from the shipped registration helper', () => {
    // The helper, not a loop copied into this file — a copy is the thing that
    // drifts from what ships.
    expect(codeOnly).toContain('registerMcpCapabilityRoleFloor(app)');
  });

  it('applies it after the endpoints register their own auth hooks', () => {
    // Feathers appends, so ordering here is what makes `ctx.requireAuth` run
    // first and lets the floor decide on an authenticated caller.
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

  it('classifies every mounted /mcp-servers endpoint as issuing or not', () => {
    const mounted = [...codeOnly.matchAll(/app\.use\(\s*'\/(mcp-servers[^']*)'/g)].map((m) => m[1]);
    expect(mounted.length).toBeGreaterThan(0);

    const unclassified = mounted.filter(
      (path) =>
        !(MCP_CAPABILITY_ISSUING_SERVICE_PATHS as readonly string[]).includes(path) &&
        !(path in NON_ISSUING_MCP_SERVICE_PATHS)
    );

    // A new endpoint lands here until somebody decides which it is. That is the
    // point: the gap this closes was an endpoint nobody classified.
    expect(unclassified).toEqual([]);
  });
});
