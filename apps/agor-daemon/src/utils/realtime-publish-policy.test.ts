import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feathers } from '@agor/core/feathers';
import { ENVIRONMENT_COMMAND_REPORT_SERVICE } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  assertRealtimePublishPolicyCoverage,
  isRealtimePublishAllowed,
  NON_SERVICE_REGISTERED_PATHS,
  REALTIME_PUBLISH_POLICY,
  RealtimePublishPolicyCoverageError,
  realtimePublishPolicyFor,
} from './realtime-publish-policy';

const DAEMON_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('realtimePublishPolicyFor', () => {
  it('denies a path that was never declared', () => {
    expect(realtimePublishPolicyFor('some-brand-new-service')).toBeUndefined();
    expect(isRealtimePublishAllowed('some-brand-new-service')).toBe(false);
  });

  it('denies a missing path rather than treating it as unscoped', () => {
    expect(isRealtimePublishAllowed(undefined)).toBe(false);
    expect(isRealtimePublishAllowed(null)).toBe(false);
    expect(isRealtimePublishAllowed('')).toBe(false);
  });

  it('resolves a declared path with or without the leading slash Feathers strips', () => {
    expect(realtimePublishPolicyFor('sessions')?.audience).toBe('branch-or-session');
    expect(realtimePublishPolicyFor('/sessions')?.audience).toBe('branch-or-session');
    expect(realtimePublishPolicyFor('/kb/documents')?.audience).toBe('knowledge');
  });

  it('declares the service read-role floors for privileged realtime rows', () => {
    expect(realtimePublishPolicyFor('users')?.minimumRole).toBe('member');
    expect(realtimePublishPolicyFor('board-objects')?.minimumRole).toBe('member');
    expect(realtimePublishPolicyFor('boards')?.minimumRole).toBeUndefined();
  });

  it('treats an explicit none declaration as not allowed', () => {
    expect(realtimePublishPolicyFor('mcp-catalog/connect')?.audience).toBe('none');
    expect(isRealtimePublishAllowed('mcp-catalog/connect')).toBe(false);
  });

  it('requires every entry to explain itself', () => {
    for (const [path, policy] of Object.entries(REALTIME_PUBLISH_POLICY)) {
      expect(policy.why.length, `${path} has no rationale`).toBeGreaterThan(10);
    }
  });
});

describe('assertRealtimePublishPolicyCoverage', () => {
  it('covers the constant-named environment report RPC even with no custom events', () => {
    const app = feathers();
    app.use(
      ENVIRONMENT_COMMAND_REPORT_SERVICE,
      {
        async create() {
          return {};
        },
      },
      { methods: ['create'], events: [] }
    );
    expect(() => assertRealtimePublishPolicyCoverage(app)).not.toThrow();
    expect(realtimePublishPolicyFor(ENVIRONMENT_COMMAND_REPORT_SERVICE)?.audience).toBe('none');
  });

  it('accepts an app whose services are all declared', () => {
    const app = { services: { sessions: {}, 'mcp-catalog/connect': {}, '/branches': {} } };
    expect(() => assertRealtimePublishPolicyCoverage(app)).not.toThrow();
  });

  it('throws and names every undeclared service', () => {
    const app = { services: { sessions: {}, 'shiny-new-thing': {}, 'another-one': {} } };
    let error: unknown;
    try {
      assertRealtimePublishPolicyCoverage(app);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RealtimePublishPolicyCoverageError);
    expect((error as RealtimePublishPolicyCoverageError).missingPaths).toEqual([
      'another-one',
      'shiny-new-thing',
    ]);
    expect((error as Error).message).toContain('shiny-new-thing');
  });

  it('ignores the Express mounts that are not services', () => {
    const app = {
      services: Object.fromEntries([...NON_SERVICE_REGISTERED_PATHS].map((p) => [p, {}])),
    };
    expect(() => assertRealtimePublishPolicyCoverage(app)).not.toThrow();
  });
});

/**
 * The startup assertion is authoritative but only fires for services that are
 * actually registered, so a flag-gated service could reach production before
 * anyone boots with its flag on. This scan reads the source instead, so a
 * missing declaration fails in CI at the pull request that adds it.
 *
 * It over-matches by design (Express middleware mounts look like service
 * registrations), which is why `NON_SERVICE_REGISTERED_PATHS` and the literals
 * below exist — an entry there is a deliberate "this is not a service", not a
 * silencer.
 */
describe('source scan: every registered path is declared', () => {
  /** String literals that reach a registration call site but are not paths. */
  const NOT_A_PATH = new Set([
    '10mb', // express.json({ limit: '10mb' })
    'application/csp-report', // express.json({ type: … })
    'gz', // expressStaticGzip extension
    'index.html', // static-assets fallback
    'string', // a typeof comparison
  ]);

  /**
   * Match on the CALL, never on the receiver.
   *
   * `.use(` catches `app.use`, `routeApp.use`, `ctx.app.use`, `this.app.use`,
   * `feathersApp.use`, `(app as any).use` and anything else a future helper
   * names its Feathers application — including one built on the generic
   * `app.use(path, service)` inside `registerAuthenticatedRoute`
   * (`utils/authorization.ts`). Anchoring on a list of receiver identifiers
   * made a registration through any other name invisible to this scan, and if
   * such a service were also flag-gated the startup assertion would not see it
   * either.
   *
   * `\.use\(\s*['"\`]` requires a string literal to open the argument list,
   * which drops `app.use(cors(...))`-style middleware without a path while
   * keeping every path-first registration.
   */
  const REGISTRATION_CALL = /\.use\(\s*['"`]|\bregister\w*AuthenticatedRoute\w*\(|\.use\($/;

  /** Extract every registered path from one file's source. Pure, so it can be driven against a fixture. */
  function extractRegisteredPaths(source: string): Array<{ path: string; line: number }> {
    // Resolve the shared constant before the literal-only scan; do not duplicate its value.
    const lines = source
      .replace(
        /\bENVIRONMENT_COMMAND_REPORT_SERVICE\b/g,
        JSON.stringify(ENVIRONMENT_COMMAND_REPORT_SERVICE)
      )
      .split('\n');
    const found: Array<{ path: string; line: number }> = [];
    lines.forEach((line, index) => {
      const start = line.search(REGISTRATION_CALL);
      if (start < 0) return;
      // The path is the first string literal of the call. It sits on the same
      // line for `app.use('/x', …)` and a line or two down for the multi-line
      // `registerAuthenticatedRoute(\n  app,\n  '/x',` form.
      const window = [line.slice(start), ...lines.slice(index + 1, index + 5)].join('\n');
      const literal = window.match(/['"]([^'"\n]*)['"]/);
      if (!literal) return;
      found.push({ path: literal[1].replace(/^\/+/, '').replace(/\/+$/, ''), line: index + 1 });
    });
    return found;
  }

  function registeredPathsInSource(): Map<string, string> {
    const files = execFileSync(
      'grep',
      ['-rlE', '\\.use\\(|register\\w*AuthenticatedRoute', DAEMON_SRC, '--include=*.ts'],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter((file) => file && !file.endsWith('.test.ts'));

    const found = new Map<string, string>();
    for (const file of files) {
      for (const { path, line } of extractRegisteredPaths(readFileSync(file, 'utf8'))) {
        if (!found.has(path)) found.set(path, `${relative(DAEMON_SRC, file)}:${line}`);
      }
    }
    return found;
  }

  it('catches a registration through any receiver, not just `app`', () => {
    // The whole point of matching on `.use(` rather than a list of receiver
    // names. Each of these is a real Feathers service registration that the
    // receiver-anchored matcher missed; a flag-gated one would then have been
    // invisible to BOTH this scan and the startup assertion.
    const fixture = [
      "  feathersApp.use('/renamed-receiver', svc);",
      "  (app as any).use('/cast-receiver', svc);",
      "  this.app.use('/this-receiver', svc);",
      "  server.app.use('/nested-receiver', svc);",
      '  someApp.use(',
      "    '/multiline-receiver',",
      '    svc',
      '  );',
      "  registerLongAuthenticatedRoute(app, '/long-route', svc);",
    ].join('\n');

    expect(extractRegisteredPaths(fixture).map((entry) => entry.path)).toEqual([
      'renamed-receiver',
      'cast-receiver',
      'this-receiver',
      'nested-receiver',
      'multiline-receiver',
      'long-route',
    ]);
  });

  it('recognizes the shared environment report service identifier', () => {
    expect(extractRegisteredPaths('app.use(ENVIRONMENT_COMMAND_REPORT_SERVICE, service);')).toEqual(
      [{ path: ENVIRONMENT_COMMAND_REPORT_SERVICE, line: 1 }]
    );
    expect(registeredPathsInSource().has(ENVIRONMENT_COMMAND_REPORT_SERVICE)).toBe(true);
  });

  it('ignores middleware mounted without a path', () => {
    // `.use(` alone would sweep these in and force junk into the ignore lists.
    const fixture = [
      '  app.use(cors({ origin: true }));',
      '  app.use(express.json({ limit: someLimit }));',
      '  app.use(createDynamicCompressionMiddleware() as never);',
    ].join('\n');

    expect(extractRegisteredPaths(fixture)).toEqual([]);
  });

  it('finds the registration call sites at all', () => {
    // Guards the scan itself: a refactor that renames the helpers would
    // otherwise turn this whole describe into a silent pass.
    const found = registeredPathsInSource();
    expect(found.has('sessions')).toBe(true);
    expect(found.has('mcp-catalog/connect')).toBe(true);
    expect(found.size).toBeGreaterThan(100);
  });

  it('declares a realtime audience for each one', () => {
    const undeclared: string[] = [];
    for (const [path, where] of registeredPathsInSource()) {
      if (NOT_A_PATH.has(path)) continue;
      if (NON_SERVICE_REGISTERED_PATHS.has(path)) continue;
      if (path.includes('${')) continue; // interpolated mount, e.g. the UI path
      if (!realtimePublishPolicyFor(path)) undeclared.push(`${path} (${where})`);
    }
    expect(undeclared).toEqual([]);
  });

  it('has no declaration for a path that is no longer registered', () => {
    // Catches a typo in a policy key, which the runtime assertion cannot see:
    // a key that matches nothing silently leaves the real path denied.
    const registered = new Set(registeredPathsInSource().keys());
    const stale = Object.keys(REALTIME_PUBLISH_POLICY).filter((path) => !registered.has(path));
    expect(stale).toEqual([]);
  });
});
