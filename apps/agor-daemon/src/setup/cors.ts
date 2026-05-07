/**
 * CORS Configuration
 *
 * Builds CORS origin configuration based on deployment environment and the
 * resolved `security.cors.*` config block.
 *
 * Inputs from the resolver (`packages/core/src/config/security-resolver.ts`):
 *   - `mode`            — list | wildcard | reflect | null-origin
 *   - `origins`         — exact strings or /regex/ patterns (used when mode=list)
 *   - `credentials`     — whether to echo Access-Control-Allow-Credentials
 *   - `methods`         — allowed methods (optional)
 *   - `allowedHeaders`  — allowed request headers (optional; reflect when unset)
 *   - `maxAgeSeconds`   — preflight cache TTL (optional)
 *   - `allowSandpack`   — accept `https://*.codesandbox.io`
 *
 * Environment-derived inputs (not part of the config block) remain here:
 *   - UI port (for the localhost allow-list)
 *
 * Backcompat: the legacy `daemon.cors_origins`, `daemon.cors_allow_sandpack`,
 * and `CORS_ORIGIN` env var continue to work via `resolveSecurity()` — by the
 * time values reach this module, they've already been merged and warned on.
 */

import type { ResolvedCors } from '@agor/core/config';
import type { CorsOptions } from 'cors';

/** CORS origin type — derived from the cors package's own CorsOptions */
export type CorsOrigin = CorsOptions['origin'];

export interface CorsConfigOptions {
  /** UI port for localhost origins (Vite dev server) */
  uiPort: number;
  /**
   * Daemon port. Must be in the localhost allow-list because in npm-installed
   * deployments the daemon serves the UI from its own origin (e.g.
   * `http://localhost:3030/ui/`), so same-origin XHR / Socket.io requests
   * carry `Origin: http://localhost:<daemonPort>` and would otherwise be
   * rejected by the cors() callback. Bug surfaced in 0.17.3 — see PR #1106.
   */
  daemonPort: number;
  /** Resolved CORS config (from `@agor/core/config` `resolveSecurity()`). */
  resolved: ResolvedCors;
}

export interface CorsConfigResult {
  /** The resolved CORS origin configuration passed to `cors()` middleware. */
  origin: CorsOrigin;
  /** Localhost origins for local development */
  localhostOrigins: string[];
  /**
   * True when the caller should allow `credentials: true` on the global cors()
   * middleware. False when the resolved policy is a wildcard reflector, in
   * which case `credentials` MUST be off per the CORS spec.
   */
  credentialsAllowed: boolean;
  /**
   * True when the resolved policy reflects any origin (wildcard/reflect).
   * Surfaced so the daemon entrypoint can refuse to boot in hardened
   * deployment modes and emit a loud warning otherwise.
   */
  isWildcard: boolean;
  /**
   * Predicate for determining whether a given origin is in the explicit
   * allow list. Used to scope `Access-Control-Allow-Private-Network` to
   * trusted origins instead of echoing it for everyone.
   */
  isAllowedOrigin: (origin: string) => boolean;
  /** Additional options (methods, allowedHeaders, maxAge) to pass to cors(). */
  extraOptions: Pick<CorsOptions, 'methods' | 'allowedHeaders' | 'maxAge'>;
}

/** Matches hosted Sandpack bundler origins like https://2-19-8-sandpack.codesandbox.io */
const SANDPACK_ORIGIN_PATTERN = /^https:\/\/[\w.-]+\.codesandbox\.io$/;

/**
 * True when `origin` is a Sandpack/CodeSandbox bundler origin. Exported so
 * the daemon entrypoint can strip credentialed CORS responses on every
 * Sandpack request (including preflights) without redefining the regex.
 */
export function isSandpackOrigin(origin: string): boolean {
  return SANDPACK_ORIGIN_PATTERN.test(origin);
}

/**
 * Parse a string as a regex pattern if wrapped in /slashes/, otherwise return null.
 * Returns null and warns on invalid regex syntax rather than throwing.
 */
function parseRegexPattern(entry: string): RegExp | null {
  if (entry.startsWith('/') && entry.endsWith('/') && entry.length > 2) {
    try {
      return new RegExp(entry.slice(1, -1));
    } catch (err) {
      console.warn(`⚠️  CORS: invalid regex pattern ${entry}, skipping: ${err}`);
      return null;
    }
  }
  return null;
}

/**
 * Build CORS origin configuration from a pre-resolved `security.cors` block.
 *
 * The resolver (in @agor/core) has already:
 *   - applied CORS_ORIGIN env var precedence over config
 *   - merged legacy `daemon.cors_origins` / `daemon.cors_allow_sandpack`
 *   - emitted deprecation warnings
 *   - rejected credentials:true + wildcard/reflect at load time
 *
 * This function is left concerned only with turning that into the runtime
 * `cors()` origin callback + the predicates the rest of the daemon uses for
 * PNA, credential stripping, etc.
 */
export function buildCorsConfig(options: CorsConfigOptions): CorsConfigResult {
  const { uiPort, daemonPort, resolved } = options;

  // Localhost allow-list:
  //   - daemon port (npm-installed mode serves the UI from the daemon origin)
  //   - UI port + 3 successors (Vite + parallel dev servers)
  const localhostOrigins = [
    `http://localhost:${daemonPort}`,
    `http://localhost:${uiPort}`,
    `http://localhost:${uiPort + 1}`,
    `http://localhost:${uiPort + 2}`,
    `http://localhost:${uiPort + 3}`,
  ];

  const extraOptions: Pick<CorsOptions, 'methods' | 'allowedHeaders' | 'maxAge'> = {};
  if (resolved.methods) extraOptions.methods = resolved.methods;
  if (resolved.allowedHeaders) extraOptions.allowedHeaders = resolved.allowedHeaders;
  if (resolved.maxAgeSeconds !== undefined) extraOptions.maxAge = resolved.maxAgeSeconds;

  // --- Wildcard / reflect: accept any origin, credentials are forced off. ---
  // `wildcard` emits Access-Control-Allow-Origin: *  (cors() option `origin: '*'`).
  // `reflect`  echoes the request's Origin header back (cors() option `origin: true`).
  // These are observably different (a `*` response cannot carry credentials even
  // via a mistake; a reflected origin can) so we keep them distinct.
  if (resolved.mode === 'wildcard' || resolved.mode === 'reflect') {
    console.warn(
      `⚠️  CORS mode=${resolved.mode} — any origin will be accepted, credentials disabled.`
    );
    return {
      origin: resolved.mode === 'wildcard' ? '*' : true,
      localhostOrigins,
      credentialsAllowed: false,
      isWildcard: true,
      // SECURITY: in wildcard/reflect mode we accept ANY origin for normal CORS,
      // but we deliberately do NOT echo Access-Control-Allow-Private-Network for
      // unknown origins. PNA is a chrome-style escape hatch that lets a public
      // origin reach a private/loopback target — even in wildcard mode, only
      // localhost (the configured UI dev port range) gets the PNA header.
      isAllowedOrigin: (origin: string) => localhostOrigins.includes(origin),
      extraOptions,
    };
  }

  // --- Null-origin: the only allowed origin is the literal string "null". ---
  if (resolved.mode === 'null-origin') {
    console.warn('⚠️  CORS mode=null-origin — only "Origin: null" requests are allowed.');
    return {
      origin: (requestOrigin, callback) => {
        if (!requestOrigin) return callback(null, true);
        if (requestOrigin === 'null') return callback(null, true);
        callback(new Error('Not allowed by CORS'));
      },
      localhostOrigins,
      credentialsAllowed: resolved.credentials,
      isWildcard: false,
      isAllowedOrigin: () => false,
      extraOptions,
    };
  }

  // --- List mode: localhost + sandpack + user-provided. ------
  const exactOrigins = new Set(localhostOrigins);
  const patterns: RegExp[] = [];

  // Tightened localhost regex: only the daemon port + configured UI port range,
  // not "any port". We accept both http and https for localhost so that
  // operators terminating TLS in front of a local UI dev server still work.
  const localhostPortRange = [daemonPort, uiPort, uiPort + 1, uiPort + 2, uiPort + 3].join('|');
  patterns.push(new RegExp(`^https?:\\/\\/localhost:(${localhostPortRange})$`));

  // Sandpack/CodeSandbox bundler (on by default, configurable).
  if (resolved.allowSandpack) {
    patterns.push(SANDPACK_ORIGIN_PATTERN);
  }

  // Additional origins from resolved config (security.cors.origins merged
  // with legacy daemon.cors_origins merged with CORS_ORIGIN env var — the
  // resolver has already done precedence resolution).
  for (const raw of resolved.origins) {
    const entry = raw.trim();
    if (!entry) continue;
    const regex = parseRegexPattern(entry);
    if (regex) {
      patterns.push(regex);
    } else {
      exactOrigins.add(entry);
    }
  }

  if (resolved.allowSandpack) {
    console.log('🔒 CORS allows Sandpack/CodeSandbox bundler origins (*.codesandbox.io)');
  }

  const isAllowedOrigin = (requestOrigin: string): boolean => {
    if (exactOrigins.has(requestOrigin)) return true;
    return patterns.some((p) => p.test(requestOrigin));
  };

  // Sandpack origins are third-party multi-tenant; we never allow credentials
  // to be sent from them even though we accept the request.
  const isSandpack = (requestOrigin: string): boolean =>
    resolved.allowSandpack && SANDPACK_ORIGIN_PATTERN.test(requestOrigin);

  const origin: CorsOrigin = (requestOrigin, callback) => {
    // Allow requests with no origin (curl, Postman, mobile apps)
    if (!requestOrigin) {
      return callback(null, true);
    }

    if (isAllowedOrigin(requestOrigin)) {
      return callback(null, true);
    }

    console.warn(`⚠️  CORS rejected origin: ${requestOrigin}`);
    callback(new Error('Not allowed by CORS'));
  };

  return {
    origin,
    localhostOrigins,
    credentialsAllowed: resolved.credentials,
    isWildcard: false,
    isAllowedOrigin: (o: string) => isAllowedOrigin(o) && !isSandpack(o),
    extraOptions,
  };
}
