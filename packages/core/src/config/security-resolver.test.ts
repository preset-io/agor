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
  resolveSecurity,
  SANDPACK_CSP_FRAME_SRC,
  SANDPACK_CSP_WORKER_SRC,
  serializeCsp,
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

describe('serializeCsp', () => {
  it('joins directives with "; " and sources with spaces', () => {
    expect(
      serializeCsp({
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://x.com'],
      })
    ).toBe("default-src 'self'; script-src 'self' https://x.com");
  });

  it('emits empty-source directives as just the name (no trailing space)', () => {
    expect(serializeCsp({ 'script-src': [] })).toBe('script-src');
  });
});
