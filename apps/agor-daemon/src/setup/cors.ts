/**
 * CORS Configuration
 *
 * Builds CORS origin configuration based on deployment environment.
 * Supports local development, GitHub Codespaces, and explicit wildcard override.
 */

/**
 * CORS origin type - matches express cors package expectations
 */
export type CorsOrigin =
  | boolean
  | string[]
  | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void);

export interface CorsConfigOptions {
  /** UI port for localhost origins */
  uiPort: number;
  /** Whether running in GitHub Codespaces */
  isCodespaces: boolean;
  /** Explicit CORS_ORIGIN environment variable override */
  corsOriginOverride?: string;
}

export interface CorsConfigResult {
  /** The resolved CORS origin configuration */
  origin: CorsOrigin;
  /** Localhost origins for local development */
  localhostOrigins: string[];
}

/**
 * Build CORS origin configuration based on deployment environment
 *
 * Priority:
 * 1. CORS_ORIGIN='*' → Allow all origins (dangerous, use with caution)
 * 2. CODESPACES=true → Allow GitHub Codespaces domains + localhost
 * 3. Default → Allow localhost ports only (UI port + 3 additional for parallel dev)
 *
 * @param options - Configuration options
 * @returns CORS origin configuration ready for express cors middleware
 */
export function buildCorsConfig(options: CorsConfigOptions): CorsConfigResult {
  const { uiPort, isCodespaces, corsOriginOverride } = options;

  // Support UI port and 3 additional ports (for parallel dev servers)
  const localhostOrigins = [
    `http://localhost:${uiPort}`,
    `http://localhost:${uiPort + 1}`,
    `http://localhost:${uiPort + 2}`,
    `http://localhost:${uiPort + 3}`,
  ];

  let origin: CorsOrigin;

  if (corsOriginOverride === '*') {
    // Explicit wildcard - allow all origins (use with caution!)
    console.warn('⚠️  CORS set to allow ALL origins (CORS_ORIGIN=*)');
    origin = true;
  } else if (isCodespaces) {
    // Codespaces: Only allow GitHub Codespaces domains and localhost
    console.log('🔒 CORS configured for GitHub Codespaces (*.github.dev, *.githubpreview.dev)');
    origin = createCodespacesCorsHandler();
  } else {
    // Local development: Allow localhost ports only
    origin = localhostOrigins;
  }

  return { origin, localhostOrigins };
}

/**
 * Create CORS handler for GitHub Codespaces environment
 *
 * Allows:
 * - Requests with no origin (mobile apps, curl, Postman)
 * - GitHub Codespaces domains (*.github.dev, *.githubpreview.dev)
 * - Localhost with any port
 */
function createCodespacesCorsHandler(): CorsOrigin {
  const allowedPatterns = [
    /\.github\.dev$/,
    /\.githubpreview\.dev$/,
    /\.preview\.app\.github\.dev$/,
    /^https?:\/\/localhost(:\d+)?$/,
  ];

  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) {
      return callback(null, true);
    }

    const isAllowed = allowedPatterns.some((pattern) => pattern.test(origin));

    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn(`⚠️  CORS rejected origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  };
}
