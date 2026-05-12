/**
 * Security config resolver tests.
 *
 * Covers:
 *   - Defaults include sandpack frame-src/worker-src so artifacts work OOTB
 *   - extras append to defaults (and de-duplicate)
 *   - override replaces defaults+extras per-directive
 *   - report_only / disabled flags are surfaced
 *   - Unknown CSP directives are rejected with a friendly error
 *   - CORS defaults, wildcard forces credentials off, mode=null-origin
 *   - credentials:true + wildcard/reflect throws at load time
 *   - CORS_ORIGIN env var overrides config values
 *   - Legacy daemon.cors_* keys merge in with a deprecation warning
 */

import { describe, expect, it, vi } from 'vitest';
import {
  getDefaultGitConfigParameters,
  gitConfigParameterLooksSecret,
  redactUrlUserinfo,
  renderGitConfigParametersForLog,
  resolveGitConfigParameters,
  resolveSecurity,
  SANDPACK_CSP_FRAME_SRC,
  SANDPACK_CSP_WORKER_SRC,
} from './security-resolver';
import type { AgorConfig } from './types';

const EMPTY: AgorConfig = {};

describe('resolveSecurity — CSP defaults', () => {
  it('bakes in sandpack frame-src + worker-src so artifacts render out of the box', () => {
    const { csp } = resolveSecurity(EMPTY, { daemonUrl: 'http://localhost:3030' });
    expect(csp.directives['frame-src']).toContain("'self'");
    expect(csp.directives['frame-src']).toContain(SANDPACK_CSP_FRAME_SRC);
    expect(csp.directives['worker-src']).toContain(SANDPACK_CSP_WORKER_SRC);
  });

  it('honours allowSandpack=false by dropping *.codesandbox.io from frame-src', () => {
    const { csp } = resolveSecurity(
      { security: { cors: { allow_sandpack: false } } },
      { daemonUrl: 'http://localhost:3030' }
    );
    expect(csp.directives['frame-src']).not.toContain(SANDPACK_CSP_FRAME_SRC);
    // Worker-src still allows blob: because Agor itself may use workers.
    expect(csp.directives['worker-src']).toContain(SANDPACK_CSP_WORKER_SRC);
  });

  it('injects the daemon URL into connect-src', () => {
    const { csp } = resolveSecurity(EMPTY, { daemonUrl: 'http://localhost:3030' });
    expect(csp.directives['connect-src']).toContain('http://localhost:3030');
    expect(csp.directives['connect-src']).toContain('ws:');
    expect(csp.directives['connect-src']).toContain('wss:');
  });

  it("script-src does NOT include 'unsafe-eval' (Handlebars rendering moved to daemon)", () => {
    // Pins the contract: any browser code that triggers `new Function` /
    // `eval` is a regression. If a future dep needs eval, prefer routing
    // through the daemon's /templates service instead of relaxing this.
    const { csp } = resolveSecurity(EMPTY);
    expect(csp.directives['script-src']).not.toContain("'unsafe-eval'");
  });

  it('style-src and font-src include fonts.bunny.net for the Inter font import', () => {
    const { csp } = resolveSecurity(EMPTY);
    expect(csp.directives['style-src']).toContain('https://fonts.bunny.net');
    expect(csp.directives['font-src']).toContain('https://fonts.bunny.net');
  });
});

describe('resolveSecurity — CSP extras/override', () => {
  it('extras append to defaults without duplicating', () => {
    const { csp } = resolveSecurity(
      {
        security: {
          csp: {
            extras: {
              'script-src': ['https://plausible.io', "'self'"], // 'self' already in defaults
              'connect-src': ['https://api.anthropic.com'],
            },
          },
        },
      },
      { daemonUrl: 'http://localhost:3030' }
    );
    expect(csp.directives['script-src']).toEqual(["'self'", 'https://plausible.io']);
    expect(csp.directives['connect-src']).toContain('https://api.anthropic.com');
  });

  it('override replaces defaults AND extras for that directive', () => {
    const { csp } = resolveSecurity({
      security: {
        csp: {
          extras: { 'img-src': ['https://should-be-dropped.example.com'] },
          override: { 'img-src': ["'self'", 'data:'] },
        },
      },
    });
    expect(csp.directives['img-src']).toEqual(["'self'", 'data:']);
  });

  it('override with empty array emits the directive with no sources (blocks it)', () => {
    const { csp } = resolveSecurity({
      security: { csp: { override: { 'script-src': [] } } },
    });
    expect(csp.directives['script-src']).toEqual([]);
    expect(csp.headerValue).toContain('script-src;');
  });

  it('rejects unknown directive names with a helpful error', () => {
    expect(() =>
      resolveSecurity({
        security: { csp: { extras: { 'not-a-directive': ['x'] } } },
      })
    ).toThrow(/unknown CSP directive/);
  });

  it('rejects non-array directive values', () => {
    expect(() =>
      resolveSecurity({
        security: {
          csp: {
            extras: { 'script-src': 'https://x.com' as unknown as string[] },
          },
        },
      })
    ).toThrow(/must be an array/);
  });
});

describe('resolveSecurity — CSP reporting + flags', () => {
  it('sets report_only flag and header name', () => {
    const { csp } = resolveSecurity({
      security: { csp: { report_only: true } },
    });
    expect(csp.reportOnly).toBe(true);
  });

  it('when report_uri is set, report-uri and report-to directives are injected', () => {
    const { csp } = resolveSecurity({
      security: { csp: { report_uri: '/api/csp-report' } },
    });
    expect(csp.reportUri).toBe('/api/csp-report');
    expect(csp.directives['report-uri']).toEqual(['/api/csp-report']);
    expect(csp.directives['report-to']).toEqual(['agor-csp']);
    expect(csp.reportToGroup).toBe('agor-csp');
  });

  it('report_uri + override of report-to uses the operator group (no drift)', () => {
    // Prevents a subtle bug where the CSP directive says `report-to my-group`
    // but the Report-To header advertises `agor-csp` — browsers would see the
    // two as unrelated and silently drop reports.
    const { csp } = resolveSecurity({
      security: {
        csp: {
          report_uri: '/api/csp-report',
          override: { 'report-to': ['my-group'] },
        },
      },
    });
    expect(csp.directives['report-to']).toEqual(['my-group']);
    expect(csp.reportToGroup).toBe('my-group');
  });

  it('report_uri + override of report-to with empty array throws (would drift)', () => {
    expect(() =>
      resolveSecurity({
        security: {
          csp: {
            report_uri: '/api/csp-report',
            override: { 'report-to': [] },
          },
        },
      })
    ).toThrow(/must contain at least one group name/);
  });

  it('disabled=true emits a warning and surfaces the flag', () => {
    const warn = vi.fn();
    const { csp } = resolveSecurity({ security: { csp: { disabled: true } } }, { onWarning: warn });
    expect(csp.disabled).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disabled=true'));
  });
});

describe('resolveSecurity — CORS', () => {
  it('defaults to list mode with empty origins and credentials=true', () => {
    const { cors } = resolveSecurity(EMPTY);
    expect(cors.mode).toBe('list');
    expect(cors.origins).toEqual([]);
    expect(cors.credentials).toBe(true);
    expect(cors.allowSandpack).toBe(true);
  });

  it('mode=wildcard forces credentials=false with a warning when user left it default', () => {
    const warn = vi.fn();
    const { cors } = resolveSecurity(
      { security: { cors: { mode: 'wildcard' } } },
      { onWarning: warn }
    );
    expect(cors.mode).toBe('wildcard');
    expect(cors.credentials).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('forces credentials=false'));
  });

  it('mode=wildcard + explicit credentials=true throws at load time', () => {
    expect(() =>
      resolveSecurity({
        security: { cors: { mode: 'wildcard', credentials: true } },
      })
    ).toThrow(/incompatible with cors.mode/);
  });

  it('mode=reflect + explicit credentials=true throws at load time', () => {
    expect(() =>
      resolveSecurity({
        security: { cors: { mode: 'reflect', credentials: true } },
      })
    ).toThrow(/incompatible with cors.mode/);
  });

  it('mode=null-origin is surfaced verbatim', () => {
    const { cors } = resolveSecurity({
      security: { cors: { mode: 'null-origin' } },
    });
    expect(cors.mode).toBe('null-origin');
  });

  it('CORS_ORIGIN="*" env var overrides config to wildcard', () => {
    const { cors } = resolveSecurity(
      { security: { cors: { mode: 'list', origins: ['https://dash.example.com'] } } },
      { corsOriginEnv: '*', onWarning: vi.fn() }
    );
    expect(cors.mode).toBe('wildcard');
    expect(cors.origins).toEqual([]);
    expect(cors.credentials).toBe(false);
  });

  it('CORS_ORIGIN env var wins over security.cors.origins with a deprecation warning', () => {
    const warn = vi.fn();
    const { cors } = resolveSecurity(
      { security: { cors: { origins: ['https://config-only.example.com'] } } },
      { corsOriginEnv: 'https://env-wins.example.com', onWarning: warn }
    );
    expect(cors.origins).toEqual(['https://env-wins.example.com']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CORS_ORIGIN env var overrides'));
  });

  it('legacy daemon.cors_origins merges in when security.cors.origins is absent', () => {
    const warn = vi.fn();
    const { cors } = resolveSecurity(EMPTY, {
      legacyCorsOrigins: ['https://legacy.example.com'],
      onWarning: warn,
    });
    expect(cors.origins).toEqual(['https://legacy.example.com']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('daemon.cors_origins is deprecated'));
  });

  it('when BOTH legacy and new origins are set, the new key wins and legacy is warned as ignored', () => {
    const warn = vi.fn();
    const { cors } = resolveSecurity(
      { security: { cors: { origins: ['https://new.example.com'] } } },
      {
        legacyCorsOrigins: ['https://legacy.example.com'],
        onWarning: warn,
      }
    );
    expect(cors.origins).toEqual(['https://new.example.com']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('daemon.cors_origins is deprecated AND ignored')
    );
  });

  it('legacy daemon.cors_allow_sandpack=false carries through with deprecation warning', () => {
    const warn = vi.fn();
    const { cors, csp } = resolveSecurity(EMPTY, {
      legacyAllowSandpack: false,
      onWarning: warn,
    });
    expect(cors.allowSandpack).toBe(false);
    expect(csp.directives['frame-src']).not.toContain(SANDPACK_CSP_FRAME_SRC);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('daemon.cors_allow_sandpack is deprecated')
    );
  });

  it('security.cors.allow_sandpack explicitly set wins over legacy value', () => {
    const { cors } = resolveSecurity(
      { security: { cors: { allow_sandpack: true } } },
      { legacyAllowSandpack: false, onWarning: vi.fn() }
    );
    expect(cors.allowSandpack).toBe(true);
  });

  it('passes methods, allowed_headers, max_age_seconds through verbatim', () => {
    const { cors } = resolveSecurity({
      security: {
        cors: {
          methods: ['GET', 'POST'],
          allowed_headers: ['X-MCP-Token', 'Authorization'],
          max_age_seconds: 600,
        },
      },
    });
    expect(cors.methods).toEqual(['GET', 'POST']);
    expect(cors.allowedHeaders).toEqual(['X-MCP-Token', 'Authorization']);
    expect(cors.maxAgeSeconds).toBe(600);
  });
});

describe('resolveSecurity — headerValue serialization', () => {
  it('joins directives with "; " and sources with spaces', () => {
    const { csp } = resolveSecurity(
      { security: { csp: { override: { 'script-src': ["'self'", 'https://x.com'] } } } },
      { onWarning: vi.fn() }
    );
    expect(csp.headerValue).toContain("script-src 'self' https://x.com");
    expect(csp.headerValue).toContain('; ');
  });

  it('emits empty-source override directives as just the name (no trailing space)', () => {
    const { csp } = resolveSecurity(
      { security: { csp: { override: { 'script-src': [] } } } },
      { onWarning: vi.fn() }
    );
    // The directive list is segment-joined with "; ", so each segment is either
    // `name` or `name src1 src2`. An empty-array override yields just `script-src`.
    const segments = csp.headerValue.split('; ');
    expect(segments).toContain('script-src');
  });
});

// ============================================================================
// security.git_config_parameters
// ============================================================================

describe('getDefaultGitConfigParameters', () => {
  it('returns a fresh mutable copy each call (callers must not mutate the shared default)', () => {
    const a = getDefaultGitConfigParameters();
    const b = getDefaultGitConfigParameters();
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // distinct array references
    // And mutating one must not affect the next call's result.
    a.push('mutation.canary=true');
    expect(getDefaultGitConfigParameters()).not.toContain('mutation.canary=true');
  });

  it('includes all the documented defense pairs (regression for accidental removal)', () => {
    const defaults = getDefaultGitConfigParameters();
    expect(defaults).toContain('transfer.credentialsInUrl=die');
    expect(defaults).toContain('protocol.file.allow=user');
    expect(defaults).toContain('protocol.ext.allow=never');
    expect(defaults).toContain('core.protectHFS=true');
    expect(defaults).toContain('core.protectNTFS=true');
  });

  // fsckObjects deliberately not defaulted — pinned so a future "tighten the
  // defaults" pass has to make a conscious decision.
  it('does NOT include fsckObjects', () => {
    const defaults = getDefaultGitConfigParameters();
    expect(defaults).not.toContain('fetch.fsckObjects=true');
    expect(defaults).not.toContain('transfer.fsckObjects=true');
  });
});

describe('resolveGitConfigParameters', () => {
  it('returns the defaults when configured value is undefined', () => {
    const out = resolveGitConfigParameters(undefined);
    expect(out).toEqual(getDefaultGitConfigParameters());
    expect(out).toContain('transfer.credentialsInUrl=die');
  });

  it('returns the defaults for an empty object (both extras and override unset)', () => {
    expect(resolveGitConfigParameters({})).toEqual(getDefaultGitConfigParameters());
  });

  it('extras: empty array == no extras (defaults remain)', () => {
    expect(resolveGitConfigParameters({ extras: [] })).toEqual(getDefaultGitConfigParameters());
  });

  it('extras: appends new keys to the defaults', () => {
    const out = resolveGitConfigParameters({
      extras: ['fetch.fsckObjects=true', 'http.proxy=http://corp:3128'],
    });
    expect(out).toContain('transfer.credentialsInUrl=die');
    expect(out).toContain('protocol.file.allow=user');
    expect(out).toContain('fetch.fsckObjects=true');
    expect(out).toContain('http.proxy=http://corp:3128');
  });

  it('extras: same key as a default overrides the default value (extras win)', () => {
    const out = resolveGitConfigParameters({ extras: ['transfer.credentialsInUrl=warn'] });
    expect(out).toContain('transfer.credentialsInUrl=warn');
    expect(out).not.toContain('transfer.credentialsInUrl=die');
    expect(out).toContain('protocol.file.allow=user');
  });

  it('extras: emits at most one entry per key (default + extras collision)', () => {
    const out = resolveGitConfigParameters({ extras: ['transfer.credentialsInUrl=warn'] });
    const credKeyEntries = out.filter((p) => p.startsWith('transfer.credentialsInUrl='));
    expect(credKeyEntries).toEqual(['transfer.credentialsInUrl=warn']);
  });

  it('extras: same-key duplicates within extras collapse to the last one (last write wins)', () => {
    const out = resolveGitConfigParameters({
      extras: ['transfer.credentialsInUrl=warn', 'transfer.credentialsInUrl=die'],
    });
    const credKeyEntries = out.filter((p) => p.startsWith('transfer.credentialsInUrl='));
    expect(credKeyEntries).toEqual(['transfer.credentialsInUrl=die']);
  });

  it('extras: whitespace around pairs is trimmed before keying (no spurious split)', () => {
    const out = resolveGitConfigParameters({ extras: ['  transfer.credentialsInUrl=warn  '] });
    expect(out).toContain('transfer.credentialsInUrl=warn');
    expect(out).not.toContain('transfer.credentialsInUrl=die'); // default got replaced
  });

  it('extras: blank / whitespace-only entries are dropped', () => {
    const out = resolveGitConfigParameters({ extras: ['', '   ', 'http.proxy=http://corp:3128'] });
    expect(out).toContain('http.proxy=http://corp:3128');
    expect(out).not.toContain('');
  });

  it('override: REPLACES defaults verbatim', () => {
    const out = resolveGitConfigParameters({ override: ['transfer.credentialsInUrl=warn'] });
    expect(out).toEqual(['transfer.credentialsInUrl=warn']);
    expect(out).not.toContain('protocol.file.allow=user');
  });

  it('override: empty array disables ALL defaults (debug escape hatch)', () => {
    expect(resolveGitConfigParameters({ override: [] })).toEqual([]);
  });

  it('throws when both extras AND override are set (ambiguous — config typo)', () => {
    expect(() => resolveGitConfigParameters({ extras: ['a=1'], override: ['b=2'] })).toThrow(
      /cannot set both/i
    );
  });

  // Runtime validation — YAML can produce shapes the TS type doesn't catch.
  describe('runtime validation', () => {
    it('treats null like unset (returns defaults)', () => {
      expect(resolveGitConfigParameters(null as never)).toEqual(getDefaultGitConfigParameters());
    });

    it('throws a migration hint when given a flat array (the v1 shape on this branch)', () => {
      expect(() => resolveGitConfigParameters(['a=1', 'b=2'] as never)).toThrow(
        /not a flat array.*extras.*override/is
      );
    });

    it('throws when configured value is a primitive (string, number)', () => {
      expect(() => resolveGitConfigParameters('a=1' as never)).toThrow(/must be an object/i);
      expect(() => resolveGitConfigParameters(42 as never)).toThrow(/must be an object/i);
    });

    it('throws when extras is a bare string instead of an array', () => {
      expect(() =>
        resolveGitConfigParameters({ extras: 'fetch.fsckObjects=true' as never })
      ).toThrow(/extras must be an array of strings/);
    });

    it('throws when extras contains a non-string item', () => {
      expect(() => resolveGitConfigParameters({ extras: ['a=1', 42 as never] })).toThrow(
        /extras must be an array of strings.*number/
      );
    });

    it('throws when override is a bare string instead of an array', () => {
      expect(() => resolveGitConfigParameters({ override: 'a=1' as never })).toThrow(
        /override must be an array of strings/
      );
    });

    it('throws when override contains a non-string item', () => {
      expect(() => resolveGitConfigParameters({ override: [{} as never] })).toThrow(
        /override must be an array of strings.*object/
      );
    });

    it('treats extras: null and override: null as unset (returns defaults)', () => {
      expect(
        resolveGitConfigParameters({ extras: null as never, override: null as never })
      ).toEqual(getDefaultGitConfigParameters());
    });
  });
});

describe('redactUrlUserinfo', () => {
  it('replaces user:pass in https URLs', () => {
    expect(redactUrlUserinfo('http.proxy=https://USER:TOK@corp:3128')).toBe(
      'http.proxy=https://<redacted>@corp:3128'
    );
  });

  it('replaces user-only userinfo (no password)', () => {
    expect(redactUrlUserinfo('https://USER@host/repo.git')).toBe(
      'https://<redacted>@host/repo.git'
    );
  });

  it('redacts userinfo embedded in a config KEY (the Codex-found case)', () => {
    expect(
      redactUrlUserinfo('url.https://USER:TOK@github.com/.insteadOf=https://github.com/')
    ).toBe('url.https://<redacted>@github.com/.insteadOf=https://github.com/');
  });

  it('leaves SCP-form URLs alone (no `://` anchor)', () => {
    expect(redactUrlUserinfo('git@github.com:foo/bar.git')).toBe('git@github.com:foo/bar.git');
  });

  it('passes plain URLs through unchanged', () => {
    expect(redactUrlUserinfo('https://corp-proxy.example:3128')).toBe(
      'https://corp-proxy.example:3128'
    );
  });
});

describe('gitConfigParameterLooksSecret', () => {
  it('detects HTTP Authorization headers, case-insensitive', () => {
    expect(
      gitConfigParameterLooksSecret('http.https://github.com/.extraheader=Authorization: Basic abc')
    ).toBe(true);
    expect(gitConfigParameterLooksSecret('http.x.extraheader=authorization: bearer xyz')).toBe(
      true
    );
  });

  it('does NOT flag the defaults', () => {
    for (const pair of getDefaultGitConfigParameters()) {
      expect(gitConfigParameterLooksSecret(pair)).toBe(false);
    }
  });
});

describe('renderGitConfigParametersForLog', () => {
  it('passes non-secret pairs through verbatim', () => {
    expect(renderGitConfigParametersForLog(['transfer.credentialsInUrl=die', 'a=b'])).toBe(
      'transfer.credentialsInUrl=die a=b'
    );
  });

  it('scrubs URL userinfo in values', () => {
    const out = renderGitConfigParametersForLog(['http.proxy=http://user:pass@corp:3128']);
    expect(out).toBe('http.proxy=http://<redacted>@corp:3128');
    expect(out).not.toContain('user:pass');
  });

  it('scrubs URL userinfo in KEYS (creds-in-key regression)', () => {
    const out = renderGitConfigParametersForLog([
      'url.https://USER:TOK@github.com/.insteadOf=https://github.com/',
    ]);
    expect(out).toBe('url.https://<redacted>@github.com/.insteadOf=https://github.com/');
    expect(out).not.toContain('USER:TOK');
  });

  it('masks values still matching Authorization after URL scrub', () => {
    const out = renderGitConfigParametersForLog([
      'http.https://x/.extraheader=Authorization: Basic abc',
    ]);
    expect(out).toContain('http.https://x/.extraheader=<redacted>');
    expect(out).not.toContain('Basic abc');
  });

  it('skips empty / whitespace entries', () => {
    expect(renderGitConfigParametersForLog(['a=1', '', '   ', 'b=2'])).toBe('a=1 b=2');
  });
});
