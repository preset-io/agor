/**
 * CORS Configuration
 *
 * Builds CORS origin configuration based on deployment environment.
 * Supports local development, GitHub Codespaces, Sandpack/CodeSandbox
 * bundler origins, and configurable extra origins via config or env var.
 */

import type { CorsOptions } from 'cors';

/** CORS origin type — derived from the cors package's own CorsOptions */
export type CorsOrigin = CorsOptions['origin'];

export interface CorsConfigOptions {
  /** UI port for localhost origins */
  uiPort: number;
  /** Whether running in GitHub Codespaces */
  isCodespaces: boolean;
  /** Explicit CORS_ORIGIN environment variable override */
  corsOriginOverride?: string;
  /** Allow Sandpack/CodeSandbox bundler origins (default: true) */
  allowSandpack?: boolean;
  /** Additional allowed origins from config (exact strings or /regex/ patterns) */
  configOrigins?: string[];
}

export interface CorsConfigResult {
  /** The resolved CORS origin configuration */
  origin: CorsOrigin;
  /** Localhost origins for local development */
  localhostOrigins: string[];
  /**
   * True when the caller should allow `credentials: true` on the global cors()
   * middleware. False when the resolved policy is a wildcard reflector (origin
   * `*` or any-origin reflection), in which case `credentials` MUST be off to
   * comply with the CORS spec and avoid credentialed cross-origin requests
   * from arbitrary sites.
   */
  credentialsAllowed: boolean;
  /**
   * True when the resolved policy reflects any origin (wildcard mode).
   * Surfaced so the daemon entrypoint can refuse to boot in hardened
   * deployment modes (solo/team) and emit a loud warning otherwise.
   */
  isWildcard: boolean;
  /**
   * Predicate for determining whether a given origin is in the explicit
   * allow list. Used to scope `Access-Control-Allow-Private-Network` to
   * trusted origins instead of echoing it for everyone.
   */
  isAllowedOrigin: (origin: string) => boolean;
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
 * Build CORS origin configuration based on deployment environment
 *
 * Priority:
 * 1. CORS_ORIGIN='*' → Allow all origins (dangerous; credentials are forced off)
 * 2. Otherwise → Callback-based handler combining:
 *    - The configured UI port on localhost (http only)
 *    - Sandpack/CodeSandbox origins (unless allowSandpack=false)
 *    - GitHub Codespaces domains (when CODESPACES=true)
 *    - Additional origins from config.yaml (cors_origins)
 *    - Additional origins from CORS_ORIGIN env var (comma-separated)
 *
 * @param options - Configuration options
 * @returns CORS origin configuration ready for express cors middleware
 */
export function buildCorsConfig(options: CorsConfigOptions): CorsConfigResult {
  const { uiPort, isCodespaces, corsOriginOverride, allowSandpack = true, configOrigins } = options;

  // Support UI port and 3 additional ports (for parallel dev servers)
  const localhostOrigins = [
    `http://localhost:${uiPort}`,
    `http://localhost:${uiPort + 1}`,
    `http://localhost:${uiPort + 2}`,
    `http://localhost:${uiPort + 3}`,
  ];

  // Explicit wildcard - allow all origins (use with caution!)
  if (corsOriginOverride?.trim() === '*') {
    console.warn('⚠️  CORS set to allow ALL origins (CORS_ORIGIN=*) — credentials disabled');
    return {
      origin: true,
      localhostOrigins,
      credentialsAllowed: false,
      isWildcard: true,
      // SECURITY: in wildcard mode we accept ANY origin for normal CORS, but
      // we deliberately do NOT echo Access-Control-Allow-Private-Network for
      // unknown origins. PNA is a chrome-style escape hatch that lets a
      // public origin reach a private/loopback target — even in wildcard
      // mode, only localhost (the configured UI dev port range) gets the
      // PNA header. Anyone else has to be added to the explicit allow-list.
      isAllowedOrigin: (origin: string) => localhostOrigins.includes(origin),
    };
  }

  // Collect exact origins and regex patterns from all sources
  const exactOrigins = new Set(localhostOrigins);
  const patterns: RegExp[] = [];

  // Tightened localhost regex: only the configured UI port range, not "any port".
  // We accept both http and https for localhost so that operators terminating
  // TLS in front of a local UI dev server still work.
  const uiPortRange = [uiPort, uiPort + 1, uiPort + 2, uiPort + 3].join('|');
  patterns.push(new RegExp(`^https?:\\/\\/localhost:(${uiPortRange})$`));

  // Sandpack/CodeSandbox bundler (on by default).
  if (allowSandpack) {
    patterns.push(SANDPACK_ORIGIN_PATTERN);
  }

  // GitHub Codespaces
  if (isCodespaces) {
    patterns.push(/\.github\.dev$/, /\.githubpreview\.dev$/, /\.preview\.app\.github\.dev$/);
    console.log('🔒 CORS configured for GitHub Codespaces (*.github.dev, *.githubpreview.dev)');
  }

  // Additional origins from config.yaml (cors_origins)
  if (configOrigins) {
    for (const raw of configOrigins) {
      const entry = raw.trim();
      if (!entry) continue;
      const regex = parseRegexPattern(entry);
      if (regex) {
        patterns.push(regex);
      } else {
        exactOrigins.add(entry);
      }
    }
  }

  // Additional origins from CORS_ORIGIN env var (comma-separated)
  if (corsOriginOverride) {
    for (const entry of corsOriginOverride
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const regex = parseRegexPattern(entry);
      if (regex) {
        patterns.push(regex);
      } else {
        exactOrigins.add(entry);
      }
    }
  }

  if (allowSandpack) {
    console.log('🔒 CORS allows Sandpack/CodeSandbox bundler origins (*.codesandbox.io)');
  }

  const isAllowedOrigin = (requestOrigin: string): boolean => {
    if (exactOrigins.has(requestOrigin)) return true;
    return patterns.some((p) => p.test(requestOrigin));
  };

  // Sandpack origins are third-party multi-tenant; we never allow credentials
  // to be sent from them even though we accept the request.
  const isSandpackOrigin = (requestOrigin: string): boolean =>
    allowSandpack && SANDPACK_ORIGIN_PATTERN.test(requestOrigin);

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

  // Wrap origin so that we can attach per-request credential decisions in the
  // calling middleware. The returned `isAllowedOrigin` is the canonical check.
  return {
    origin,
    localhostOrigins,
    credentialsAllowed: true,
    isWildcard: false,
    isAllowedOrigin: (o: string) => isAllowedOrigin(o) && !isSandpackOrigin(o),
  };
}
