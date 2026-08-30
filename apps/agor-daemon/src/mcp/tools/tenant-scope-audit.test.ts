import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guard against the "Missing tenant database scope" class of bug.
 *
 * MCP tool handlers enter only tenant *context* at the boundary
 * (`tenantScopedToolProxy`). A daemon service's *custom* (non-Feathers-transport)
 * method that reads/writes `this.db` therefore needs an explicit tenant *database*
 * scope at the call site (`runWithMcpTenantDatabaseScope`), unless the method
 * defends itself internally. Standard transport methods (find/get/create/update/
 * patch/remove) go through Feathers hooks and are already scoped.
 *
 * This test scans every `mcp/tools/*.ts` file for `<x>Service.<method>(` calls to
 * non-transport methods and fails if one is neither wrapped at the call site nor
 * on the explicit, justified allow-list below. Reads use
 * `runWithMcpTenantDatabaseScope`; MUTATIONS use `runWithMcpTenantDatabaseWrite`
 * (which also enforces the tenant write-freeze gate) — the scan accepts either.
 * It scans the AST-free source (comments stripped) and matches balanced
 * `runWithMcpTenantDatabase{Scope,Write}(...)` spans, so it handles both
 * `() => svc.method()` and multi-statement `async (db) => { ...; return
 * svc.method() }` wrappers.
 *
 * It caught `agor_cards_get` and `agor_sessions_archive`/`_unarchive` slipping
 * through the first fix pass; keep it green.
 */

const TOOLS_DIR = __dirname;

// Feathers standard transport methods — hook-scoped, never need a call-site wrap.
const TRANSPORT_METHODS = new Set(['find', 'get', 'create', 'update', 'patch', 'remove']);

/**
 * `<serviceVar>.<method>` calls that are intentionally NOT wrapped at the MCP call
 * site, each with the reason it is nonetheless safe. Keyed by the exact call token
 * so an unwrapped `boardsService.unarchive` is still flagged even though
 * `branchesService.unarchive` is allow-listed.
 */
const ALLOWED_UNWRAPPED: Record<string, string> = {
  // BranchesService defends its custom methods with the private
  // `withTenantDatabase(params, work)` short-unit helper (directly or via
  // `loadEnvironmentForAction`), and must NOT hold a transaction across the
  // executor/network work these env methods perform.
  'branchesService.unarchive': 'BranchesService.withTenantDatabase (short unit)',
  'branchesService.startEnvironment': 'loadEnvironmentForAction -> withTenantDatabase',
  'branchesService.stopEnvironment': 'loadEnvironmentForAction -> withTenantDatabase',
  'branchesService.nukeEnvironment': 'loadEnvironmentForAction -> withTenantDatabase',
  'branchesService.getLogs': 'loadEnvironmentForAction -> withTenantDatabase',
  'branchesService.renderEnvironment': 'loadEnvironmentForAction -> withTenantDatabase',
  'branchesService.checkHealth': 'withTenantDatabase (short unit)',
  // GatewayService is identity-only; its repositories are
  // `bindRepositoryToTenantUnitOfWork`-bound, so each access opens its own short
  // tenant unit.
  'gatewayService.emitMessage': 'channelRepo bound to tenant unit of work',
  // Rejected with BadRequest in required_from_auth BEFORE any DB touch, and it
  // awaits a git.repo.inspect executor round-trip before its writes — wrapping
  // would risk a transaction across network I/O. See repos.ts.
  'reposService.addLocalRepository': 'HA-forbidden before any DB touch; intentional',
};

/**
 * Services whose custom methods rely on a call-site tenant scope (they do NOT
 * self-scope). The scanner keys on the conventional `<name>Service` local for
 * these; the naming convention itself is enforced by a separate test so an
 * aliased handle (e.g. `const svc = ctx.app.service('cards')`) can't evade it.
 * Self-scoping services (branches/gateway/artifacts) are intentionally absent.
 */
const CALL_SITE_SCOPED_SERVICES = ['repos', 'boards', 'cards', 'sessions', 'board-objects'];

/**
 * `<serviceVar>.<method>` mutators that this PR brought onto the WRITE helper
 * (`runWithMcpTenantDatabaseWrite`), which also enforces the tenant write-freeze
 * gate. The read-only scope helper would silently skip the gate, so this list
 * guards against a future edit downgrading one of them to the read helper.
 *
 * NOTE: this is the set with gated HTTP-route parity, not every MCP mutation.
 * Other pre-existing MCP mutations (cards/board-object custom methods, and
 * non-`Service.method` writes such as direct repositories / `appendSystemMessage`)
 * still use the read helper and are the subject of the documented service-side
 * write-gate follow-up — see docs/internal/mcp-tenant-db-scope-createbranch-2026-08-29.md.
 */
const MUTATION_TOKENS = new Set([
  'reposService.createBranch',
  'reposService.cloneRepository',
  'reposService.updateMetadata',
  'boardsService.archive',
  'boardsService.unarchive',
  'sessionsService.archive',
  'sessionsService.unarchive',
]);

/** Balanced-paren spans of every call matching `opener`. */
function helperSpans(code: string, opener: RegExp): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
  while ((m = opener.exec(code)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // index of the opening '('
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')' && --depth === 0) break;
    }
    spans.push([m.index, i]);
  }
  return spans;
}

/** Spans of either scope helper (reads or writes) — for the "is scoped at all" check. */
const scopeSpans = (code: string) =>
  helperSpans(code, /runWithMcpTenantDatabase(?:Scope|Write)\s*\(/g);
/** Spans of the WRITE helper only — for the "mutations honor the freeze gate" check. */
const writeSpans = (code: string) => helperSpans(code, /runWithMcpTenantDatabaseWrite\s*\(/g);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

describe('MCP tool tenant database scope audit', () => {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('scans a non-trivial set of tool files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('wraps every non-transport service-method call in runWithMcpTenantDatabaseScope (or allow-lists it)', () => {
    const violations: string[] = [];

    for (const file of files) {
      const code = stripComments(readFileSync(join(TOOLS_DIR, file), 'utf8'));
      const spans = scopeSpans(code);
      const guarded = (idx: number) => spans.some(([s, e]) => idx >= s && idx <= e);

      const call = /\b([a-zA-Z]+Service)\.([a-zA-Z]+)\(/g;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
      while ((m = call.exec(code)) !== null) {
        const [, serviceVar, method] = m;
        if (TRANSPORT_METHODS.has(method)) continue;
        const token = `${serviceVar}.${method}`;
        if (guarded(m.index)) continue;
        if (token in ALLOWED_UNWRAPPED) continue;
        violations.push(`${file}:${lineOf(code, m.index)}  ${token}()`);
      }
    }

    expect(
      violations,
      `Unguarded MCP custom-method service calls (wrap in runWithMcpTenantDatabaseScope, or add to ALLOWED_UNWRAPPED with a reason):\n${violations.join('\n')}`
    ).toEqual([]);
  });

  it('wraps every mutating custom-method call in the WRITE helper (freeze gate honored)', () => {
    const violations: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(join(TOOLS_DIR, file), 'utf8'));
      const writes = writeSpans(code);
      const inWrite = (idx: number) => writes.some(([s, e]) => idx >= s && idx <= e);

      const call = /\b([a-zA-Z]+Service)\.([a-zA-Z]+)\(/g;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
      while ((m = call.exec(code)) !== null) {
        const token = `${m[1]}.${m[2]}`;
        if (!MUTATION_TOKENS.has(token)) continue;
        if (inWrite(m.index)) continue;
        violations.push(`${file}:${lineOf(code, m.index)}  ${token}()`);
      }
    }
    expect(
      violations,
      `Mutating MCP calls must use runWithMcpTenantDatabaseWrite (it enforces the tenant write-freeze gate; the read-only scope helper skips it):\n${violations.join('\n')}`
    ).toEqual([]);
  });

  it('keeps the mutation-token list honest (every entry is still called somewhere)', () => {
    const allCode = files
      .map((f) => stripComments(readFileSync(join(TOOLS_DIR, f), 'utf8')))
      .join('\n');
    const stale = [...MUTATION_TOKENS].filter((token) => !allCode.includes(`${token}(`));
    expect(stale, `Stale MUTATION_TOKENS entries (no longer called): ${stale.join(', ')}`).toEqual(
      []
    );
  });

  it('does not alias a call-site-scoped service to a non-<name>Service local (which would evade the scan)', () => {
    // The scan above keys on `<name>Service` locals. Guard the convention: a
    // handle for a call-site-scoped service (e.g. `const svc = ctx.app.service(
    // 'cards')`) assigned to a variable that does not end in `Service` would hide
    // its custom-method calls. Self-scoping services (artifacts/branches/gateway)
    // may use any alias.
    const offenders: string[] = [];
    const assign = /const\s+([a-zA-Z][a-zA-Z0-9]*)\s*=\s*ctx\.app\.service\(\s*'([^']+)'/g;
    for (const file of files) {
      const code = stripComments(readFileSync(join(TOOLS_DIR, file), 'utf8'));
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
      while ((m = assign.exec(code)) !== null) {
        const [, varName, serviceName] = m;
        if (CALL_SITE_SCOPED_SERVICES.includes(serviceName) && !varName.endsWith('Service')) {
          offenders.push(
            `${file}:${lineOf(code, m.index)}  const ${varName} = service('${serviceName}')`
          );
        }
      }
    }
    expect(
      offenders,
      `Alias a call-site-scoped service to a <name>Service local so the scope audit sees its calls:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('keeps the allow-list honest (every entry is still called somewhere)', () => {
    const allCode = files
      .map((f) => stripComments(readFileSync(join(TOOLS_DIR, f), 'utf8')))
      .join('\n');
    const stale = Object.keys(ALLOWED_UNWRAPPED).filter((token) => !allCode.includes(`${token}(`));
    expect(
      stale,
      `Stale ALLOWED_UNWRAPPED entries (no longer called): ${stale.join(', ')}`
    ).toEqual([]);
  });
});
