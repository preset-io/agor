import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  const REGISTRATION_CALL =
    /(?:\bapp\.use|\brouteApp\.use|\bctx\.app\.use|registerAuthenticatedRoute|registerLongAuthenticatedRoute|registerAuthenticatedRouteBase)\(/;

  function registeredPathsInSource(): Map<string, string> {
    const files = execFileSync(
      'grep',
      [
        '-rlE',
        'app\\.use\\(|registerAuthenticatedRoute|registerLongAuthenticatedRoute',
        DAEMON_SRC,
        '--include=*.ts',
      ],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter((file) => file && !file.endsWith('.test.ts'));

    const found = new Map<string, string>();
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const start = line.search(REGISTRATION_CALL);
        if (start < 0) return;
        // The path is the first string literal of the call. It sits on the same
        // line for `app.use('/x', …)` and a line or two down for the multi-line
        // `registerAuthenticatedRoute(\n  app,\n  '/x',` form.
        const window = [line.slice(start), ...lines.slice(index + 1, index + 5)].join('\n');
        const literal = window.match(/['"]([^'"\n]*)['"]/);
        if (!literal) return;
        const path = literal[1].replace(/^\/+/, '').replace(/\/+$/, '');
        if (!found.has(path)) found.set(path, `${relative(DAEMON_SRC, file)}:${index + 1}`);
      });
    }
    return found;
  }

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
