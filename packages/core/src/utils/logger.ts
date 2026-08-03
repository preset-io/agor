/**
 * Console monkey-patch for log level filtering.
 * Respects LOG_LEVEL env var (debug/info/warn/error).
 */

import { format } from 'node:util';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface ConsoleWithOriginals extends Console {
  __originalMethods?: {
    debug: typeof console.debug;
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
  };
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const JOURNAL_PRIORITIES: Record<LogLevel, string> = {
  debug: '<7>',
  info: '<6>',
  warn: '<4>',
  error: '<3>',
};

export function getCurrentLogLevel(): LogLevel {
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

function write(original: (...args: unknown[]) => void, level: LogLevel, args: unknown[]) {
  if (!shouldLog(level)) return;
  if (!process.env.JOURNAL_STREAM) {
    original(...args);
    return;
  }

  // Format the complete console call first so embedded newlines in any
  // argument (notably Error stacks and object dumps) are all classified.
  const priority = JOURNAL_PRIORITIES[level];
  original(format(...args).replace(/^/gm, priority));
}

export function patchConsole() {
  const originalDebug = console.debug;
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.debug = (...args: unknown[]) => {
    write(originalDebug, 'debug', args);
  };

  console.log = (...args: unknown[]) => {
    write(originalLog, 'info', args);
  };

  console.info = (...args: unknown[]) => {
    write(originalInfo, 'info', args);
  };

  console.warn = (...args: unknown[]) => {
    write(originalWarn, 'warn', args);
  };

  console.error = (...args: unknown[]) => {
    write(originalError, 'error', args);
  };

  (console as ConsoleWithOriginals).__originalMethods = {
    debug: originalDebug,
    log: originalLog,
    info: originalInfo,
    warn: originalWarn,
    error: originalError,
  };
}

export function unpatchConsole() {
  const originals = (console as ConsoleWithOriginals).__originalMethods;
  if (originals) {
    console.debug = originals.debug;
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
    delete (console as ConsoleWithOriginals).__originalMethods;
  }
}
