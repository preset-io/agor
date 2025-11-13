/**
 * Console monkey-patch for environment-aware logging.
 *
 * Patches global console methods to respect LOG_LEVEL environment variable.
 * This allows all existing console.log/debug calls throughout the codebase
 * to automatically respect log levels without code changes.
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
 *
 * Call patchConsole() once at daemon startup.
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
 * Patch global console methods to respect log levels.
 *
 * This allows existing console.debug/log/warn/error calls throughout the
 * codebase to automatically respect LOG_LEVEL without code changes.
 *
 * Call this once at daemon startup.
 */
export function patchConsole() {
  const originalDebug = console.debug;
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  // Patch console.debug to respect log level
  console.debug = (...args: unknown[]) => {
    if (shouldLog('debug')) {
      originalDebug(...args);
    }
  };

  // Treat console.log as debug level (most verbose)
  console.log = (...args: unknown[]) => {
    if (shouldLog('debug')) {
      originalLog(...args);
    }
  };

  // console.info respects info level
  console.info = (...args: unknown[]) => {
    if (shouldLog('info')) {
      originalInfo(...args);
    }
  };

  // console.warn respects warn level
  console.warn = (...args: unknown[]) => {
    if (shouldLog('warn')) {
      originalWarn(...args);
    }
  };

  // console.error always shows (highest priority)
  console.error = (...args: unknown[]) => {
    if (shouldLog('error')) {
      originalError(...args);
    }
  };

  // Store originals in case we need to restore
  (console as any).__originalMethods = {
    debug: originalDebug,
    log: originalLog,
    info: originalInfo,
    warn: originalWarn,
    error: originalError,
  };
}

/**
 * Restore original console methods (useful for testing)
 */
export function unpatchConsole() {
  const originals = (console as any).__originalMethods;
  if (originals) {
    console.debug = originals.debug;
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
    delete (console as any).__originalMethods;
  }
}
