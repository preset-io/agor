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
}

/** Matches hosted Sandpack bundler origins like https://2-19-8-sandpack.codesandbox.io */
const SANDPACK_ORIGIN_PATTERN = /^https:\/\/[\w.-]+\.codesandbox\.io$/;

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
 * 1. CORS_ORIGIN='*' → Allow all origins (dangerous, use with caution)
 * 2. Otherwise → Callback-based handler combining:
 *    - Localhost ports (UI port + 3 additional for parallel dev)
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
    console.warn('⚠️  CORS set to allow ALL origins (CORS_ORIGIN=*)');
    return { origin: true, localhostOrigins };
  }

  // Collect exact origins and regex patterns from all sources
  const exactOrigins = new Set(localhostOrigins);
  const patterns: RegExp[] = [
    /^https?:\/\/localhost(:\d+)?$/, // Any localhost port
  ];

  // Sandpack/CodeSandbox bundler (on by default)
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

  const origin: CorsOrigin = (requestOrigin, callback) => {
    // Allow requests with no origin (curl, Postman, mobile apps)
    if (!requestOrigin) {
      return callback(null, true);
    }

    if (exactOrigins.has(requestOrigin) || patterns.some((p) => p.test(requestOrigin))) {
      return callback(null, true);
    }

    console.warn(`⚠️  CORS rejected origin: ${requestOrigin}`);
    callback(new Error('Not allowed by CORS'));
  };

  return { origin, localhostOrigins };
}
