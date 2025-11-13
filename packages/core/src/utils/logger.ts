/**
 * Console monkey-patch for log level filtering.
 * Respects LOG_LEVEL env var (debug/info/warn/error).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getCurrentLogLevel(): LogLevel {
  const logLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (logLevel && logLevel in LOG_LEVELS) {
    return logLevel as LogLevel;
  }

  if (process.env.DEBUG) {
    const debug = process.env.DEBUG;
    if (debug === '*' || debug.includes('agor')) {
      return 'debug';
    }
  }

  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const currentLevel = getCurrentLogLevel();

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

export function patchConsole() {
  const originalDebug = console.debug;
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.debug = (...args: unknown[]) => {
    if (shouldLog('debug')) originalDebug(...args);
  };

  console.log = (...args: unknown[]) => {
    if (shouldLog('debug')) originalLog(...args);
  };

  console.info = (...args: unknown[]) => {
    if (shouldLog('info')) originalInfo(...args);
  };

  console.warn = (...args: unknown[]) => {
    if (shouldLog('warn')) originalWarn(...args);
  };

  console.error = (...args: unknown[]) => {
    if (shouldLog('error')) originalError(...args);
  };

  (console as any).__originalMethods = {
    debug: originalDebug,
    log: originalLog,
    info: originalInfo,
    warn: originalWarn,
    error: originalError,
  };
}

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
