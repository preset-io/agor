/**
 * Console monkey-patch for log level filtering.
 * Respects LOG_LEVEL env var (debug/info/warn/error).
 *
 * AGOR_LOG_FORMAT=json (opt-in; default `text`) emits one JSON object per
 * console call on stdout, carrying the active run context (see log-context.ts).
 */

import { format } from 'node:util';
import { getLogContext } from './log-context';

type LogFormat = 'text' | 'json';

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

function getCurrentLogFormat(): LogFormat {
  return process.env.AGOR_LOG_FORMAT?.toLowerCase() === 'json' ? 'json' : 'text';
}

const currentFormat = getCurrentLogFormat();

/** Cap on the JSON `message` field, in UTF-8 bytes. */
const MAX_JSON_MESSAGE_BYTES = 16 * 1024;

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function truncateMessage(message: string): { message: string; truncated: boolean } {
  if (Buffer.byteLength(message, 'utf8') <= MAX_JSON_MESSAGE_BYTES) {
    return { message, truncated: false };
  }
  // A cut through a multi-byte character decodes to U+FFFD; drop that remnant.
  const cut = Buffer.from(message, 'utf8')
    .subarray(0, MAX_JSON_MESSAGE_BYTES)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return { message: cut, truncated: true };
}

/**
 * One JSON line. `timestamp`, `status` and `message` are the only reserved
 * keys; host metadata (service, env, version, ...) belongs to the collector.
 */
function formatJsonLine(level: LogLevel, text: string): string {
  const { message, truncated } = truncateMessage(text);
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    status: level,
    message,
    ...(truncated ? { message_truncated: true } : {}),
    ...getLogContext(),
  });
}

function formatJournalLine(level: LogLevel, text: string): string {
  return text.replace(/^/gm, JOURNAL_PRIORITIES[level]);
}

// Every JSON line goes through the pre-patch console.log, so all levels share stdout.
let jsonSink: (line: string) => void = (line) => {
  process.stdout.write(`${line}\n`);
};

function write(original: (...args: unknown[]) => void, level: LogLevel, args: unknown[]) {
  if (!shouldLog(level)) return;
  if (currentFormat === 'json') {
    jsonSink(formatJsonLine(level, format(...args)));
    return;
  }
  if (!process.env.JOURNAL_STREAM) {
    original(...args);
    return;
  }

  // Format the complete console call first so embedded newlines in any
  // argument (notably Error stacks and object dumps) are all classified.
  original(formatJournalLine(level, format(...args)));
}

/**
 * Write one already-formatted line straight to the process stream, bypassing
 * the console. For paths where the console is suppressed (e.g. while an SDK
 * runs). JSON mode writes to stdout; text mode keeps warn/error on stderr.
 */
export function writeLogLine(level: LogLevel, text: string): void {
  if (!shouldLog(level)) return;
  if (currentFormat === 'json') {
    process.stdout.write(`${formatJsonLine(level, text)}\n`);
    return;
  }
  const line = process.env.JOURNAL_STREAM ? formatJournalLine(level, text) : text;
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

/**
 * Node prints process warnings as multi-line stderr text. In JSON mode, log
 * the closed name and code only (never the warning text); pair with
 * NODE_NO_WARNINGS=1 to turn off Node's own printer. Existing listeners stay.
 */
function onProcessWarning(warning: Error & { code?: unknown }): void {
  const name = /^[A-Za-z0-9_.-]{1,64}$/.test(warning.name) ? warning.name : 'unknown';
  const code =
    typeof warning.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(warning.code)
      ? warning.code
      : 'none';
  console.warn(`[process.warning] name=${name} code=${code}`);
}

export function patchConsole() {
  const originalDebug = console.debug;
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  jsonSink = (line) => originalLog(line);

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

  if (currentFormat === 'json' && !process.listeners('warning').includes(onProcessWarning)) {
    process.on('warning', onProcessWarning);
  }
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
  process.off('warning', onProcessWarning);
}
