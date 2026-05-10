import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression tests for the `/mcp-servers/discover` endpoint's template
 * resolution.
 *
 * Background: a previous bug had the discover endpoint passing
 * `serverConfig.auth` straight to `resolveMCPAuthHeaders`, with no
 * Handlebars resolution. Servers configured with the recommended
 * `{{ user.env.X }}` syntax for bearer/JWT tokens had the literal
 * template string sent as the Authorization header, the upstream MCP
 * server returned 401, and the UI surfaced "Connection failed" — even
 * though the same servers worked fine in real sessions (the executor
 * resolves these templates via process.env + AGOR_USER_ENV_KEYS).
 *
 * The fix loads the caller's user env vars from the DB, builds the same
 * template context the executor uses, and runs `resolveMcpServerTemplates`
 * over the probe before `resolveMCPAuthHeaders` runs.
 *
 * These structural assertions intentionally operate on a window scoped to
 * the discover endpoint: they prevent removing or reordering the resolver
 * call without flagging unrelated changes elsewhere in `register-services.ts`.
 */
describe('register-services /mcp-servers/discover template resolution', () => {
  const rawSource = readFileSync(join(__dirname, 'register-services.ts'), 'utf8');

  // Strip block + line comments so prose mentioning the old buggy behavior
  // can't satisfy or fool the assertions below. Keep `://` so URLs survive.
  const codeOnly = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  /**
   * Slice the discover endpoint body. We anchor on the unique
   * `app.use('/mcp-servers/discover'` registration and stop at the next
   * top-level `app.use(` or `app.service(` registration so refactors
   * inside the endpoint stay covered while unrelated surrounding code
   * doesn't leak in.
   */
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

  it('resolves Handlebars templates before building auth headers', () => {
    // Without resolveMcpServerTemplates, the literal `{{ user.env.X }}`
    // string is sent as the Authorization header → 401.
    expect(discoverBlock).toMatch(/\bresolveMcpServerTemplates\s*\(/);

    // The probe must resolve templates BEFORE handing the auth config to
    // resolveMCPAuthHeaders — otherwise the resolution is dead code.
    const resolveIdx = discoverBlock.search(/\bresolveMcpServerTemplates\s*\(/);
    const headersIdx = discoverBlock.search(/\bresolveMCPAuthHeaders\s*\(/);
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(headersIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(headersIdx);
  });

  it("loads the caller's user env vars from the DB to build the template context", () => {
    // The daemon's process.env never holds user secrets — they live
    // encrypted in the users table. Without resolveUserEnvironment the
    // template context is empty and every {{ user.env.X }} resolves to
    // undefined, masking the original bug as a different error.
    expect(discoverBlock).toMatch(/\bresolveUserEnvironment\s*\(/);

    // buildMCPTemplateContextFromEnv keys off AGOR_USER_ENV_KEYS to
    // decide which keys are user-scoped. The synthetic env we construct
    // here MUST include that tag — forgetting it produces an empty
    // context even when user vars are loaded.
    expect(discoverBlock).toMatch(/\bbuildMCPTemplateContextFromEnv\s*\(/);
    expect(discoverBlock).toMatch(/\bAGOR_USER_ENV_KEYS_VAR\b/);
  });
});
