/**
 * Simple logging utility with environment-aware log levels.
 *
 * Respects LOG_LEVEL or DEBUG environment variables:
 * - LOG_LEVEL=debug: Show all logs (debug, info, warn, error)
 * - LOG_LEVEL=info: Show info, warn, error (default in production)
 * - LOG_LEVEL=warn: Show warn, error
 * - LOG_LEVEL=error: Show error only
 * - DEBUG=agor:* or DEBUG=*: Enable debug logs
 *
 * In development (NODE_ENV=development), defaults to debug level.
 * In production (NODE_ENV=production), defaults to info level.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Get current log level from environment
 */
function getCurrentLogLevel(): LogLevel {
  // Check LOG_LEVEL env var
  const logLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (logLevel && logLevel in LOG_LEVELS) {
    return logLevel as LogLevel;
  }

  // Check DEBUG env var (common convention for debug logging)
  if (process.env.DEBUG) {
    const debug = process.env.DEBUG;
    // Enable debug if DEBUG=* or DEBUG=agor:* or DEBUG includes 'agor'
    if (debug === '*' || debug.includes('agor')) {
      return 'debug';
    }
  }

  // Default based on NODE_ENV
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const currentLevel = getCurrentLogLevel();

/**
 * Check if a log level should be shown
 */
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/**
 * Logger with environment-aware log levels
 */
export const logger = {
  debug: (...args: unknown[]) => {
    if (shouldLog('debug')) {
      console.debug(...args);
    }
  },
  info: (...args: unknown[]) => {
    if (shouldLog('info')) {
      console.info(...args);
    }
  },
  warn: (...args: unknown[]) => {
    if (shouldLog('warn')) {
      console.warn(...args);
    }
  },
  error: (...args: unknown[]) => {
    if (shouldLog('error')) {
      console.error(...args);
    }
  },
};

/**
 * Create a namespaced logger for a specific module
 *
 * @param namespace - Module name (e.g., 'git', 'auth', 'repos')
 */
export function createLogger(namespace: string) {
  return {
    debug: (...args: unknown[]) => logger.debug(`[${namespace}]`, ...args),
    info: (...args: unknown[]) => logger.info(`[${namespace}]`, ...args),
    warn: (...args: unknown[]) => logger.warn(`[${namespace}]`, ...args),
    error: (...args: unknown[]) => logger.error(`[${namespace}]`, ...args),
  };
}
