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
