import { constants } from 'node:os';
import { projectClaudeResultResponse, SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE } from '@agor/core';
import {
  asMCPExternalError,
  isMCPAbortError,
  MCPExternalError,
  type MCPExternalErrorCategory,
} from '@agor/core/mcp';

/** Diagnostic hints only: none of these categories grants credential recovery or retry authority. */
export type ClaudeExecutionErrorCategory =
  | 'authentication'
  | 'credit_exhausted'
  | 'rate_limit'
  | 'quota'
  | 'overloaded'
  | 'turn_limit'
  | 'budget_limit'
  | 'structured_output_limit'
  | 'process_failure'
  | 'network'
  | 'unknown';

interface DiagnosticOptions {
  cause?: unknown;
  exitCode?: number;
  signal?: string;
  errorClass?: string;
  code?: string;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const PROCESS_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOEXEC',
  'EAGAIN',
  'EMFILE',
  'ENOMEM',
]);
const ERROR_CLASSES = new Set([
  'error_result',
  'executable_not_found',
  'executable_launch_failed',
  'spawn_failed',
  'process_error',
  'initialize_timeout',
  'process_killed_by_signal',
  'process_exited_nonzero',
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);
const SIGNALS = new Set(Object.keys(constants.signals));

/** Own data only: provider exceptions can have getters, proxies and custom coercion hooks. */
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function instanceOf<T extends Error>(
  value: unknown,
  type: new (...args: never[]) => T
): value is T {
  try {
    return value instanceof type;
  } catch {
    return false;
  }
}

function allowed(value: unknown, values: ReadonlySet<string>): string | undefined {
  return typeof value === 'string' && values.has(value) ? value : undefined;
}

function exitCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : undefined;
}

export class ClaudeExecutionError extends Error {
  readonly category: ClaudeExecutionErrorCategory;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly errorClass?: string;
  readonly code?: string;

  constructor(
    category: ClaudeExecutionErrorCategory,
    message: string,
    options?: DiagnosticOptions
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'ClaudeExecutionError';
    this.category = category;
    this.exitCode = exitCode(options?.exitCode);
    this.signal = allowed(options?.signal, SIGNALS);
    this.errorClass = allowed(options?.errorClass, ERROR_CLASSES);
    this.code = allowed(options?.code, NETWORK_CODES) ?? allowed(options?.code, PROCESS_CODES);
  }
}

/** Locally authored setup guidance, not a provider classification. */
export class AgorSetupError extends Error {
  override readonly name = 'AgorSetupError';
}

export function isClaudeAbortError(error: unknown): boolean {
  return isMCPAbortError(error) || own(error, 'errorClass') === 'aborted';
}

export function logClaudeFailure(
  label: string,
  error: unknown,
  extra?: { sessionId?: string; taskId?: string; messageCount?: number; hasStderr?: boolean },
  logger: { error: (...args: unknown[]) => void } = console
): void {
  // Do not log arbitrary exception messages, even for local persistence/setup failures.
  // Category and closed diagnostic fields are sufficient; cause is never serialized.
  if (instanceOf(error, ClaudeExecutionError)) {
    logger.error(label, {
      ...extra,
      category: error.category,
      errorClass: error.errorClass,
      exitCode: error.exitCode,
      signal: error.signal,
      code: error.code,
    });
  } else if (instanceOf(error, MCPExternalError)) {
    const safe = asMCPExternalError(error, { stage: 'runtime' });
    logger.error(label, { ...extra, category: safe.category, ...safe.diagnostic });
  } else {
    logger.error(label, {
      ...extra,
      category: instanceOf(error, AgorSetupError) ? 'setup_error' : 'agor_processing',
    });
  }
}

export const MESSAGES = {
  authentication:
    'Claude Code could not authenticate. Check your Claude Code provider credentials and account access.',
  creditExhausted:
    'Claude Code reported insufficient provider credit. Check billing with your configured provider.',
  rateLimit: 'Claude Code rate limit reached. Please wait before retrying your request.',
  quota:
    'Claude Code provider quota was exceeded. Check the quota limits with your configured provider.',
  overloaded: 'Claude Code is temporarily unavailable. Please retry shortly.',
  turnLimit: 'Claude Code reached the maximum turn limit for this task.',
  budgetLimit: 'Claude Code reached the maximum budget limit for this task.',
  structuredOutputLimit: 'Claude Code reached the retry limit for structured output.',
  network: 'Claude Code could not reach the network service. Check your connection and retry.',
  initializeTimeout: 'Claude Code did not start in time. Retry your request.',
  executableNotFound:
    'Claude Code executable was not found. Please verify your Claude Code installation.',
  executableLaunchFailed:
    'Claude Code executable failed to launch. Verify system runtime compatibility and permissions.',
  spawnFailed: 'Failed to spawn Claude Code process. Verify your environment and permissions.',
  processFailure:
    'Claude Code encountered a system error. Check the runtime environment and permissions; review any output and tool activity before retrying.',
  processSignal: (signal?: string) =>
    signal
      ? `Claude Code process was terminated by signal ${signal}.`
      : 'Claude Code process was terminated by a signal.',
  processExit: (code?: number) =>
    code !== undefined
      ? `Claude Code process exited unexpectedly (code ${code}). Review any output and tool activity before retrying.`
      : 'Claude Code process exited unexpectedly. Review any output and tool activity before retrying.',
  unknown:
    'Claude Code execution failed. Review any output and tool activity before retrying; contact your administrator if it continues.',
} as const;

function failure(
  category: ClaudeExecutionErrorCategory,
  message: string,
  diag?: DiagnosticOptions
) {
  return new ClaudeExecutionError(category, message, diag);
}

function httpFailure(status: unknown, diag?: DiagnosticOptions): ClaudeExecutionError | undefined {
  switch (status) {
    case 401:
    case 403:
      return failure('authentication', MESSAGES.authentication, diag);
    case 429:
      return failure('rate_limit', MESSAGES.rateLimit, diag);
    case 500:
    case 502:
    case 503:
    case 504:
    case 529:
      return failure('overloaded', MESSAGES.overloaded, diag);
    default:
      return undefined;
  }
}

function limitFailure(
  subtype: unknown,
  diag?: DiagnosticOptions
): ClaudeExecutionError | undefined {
  switch (subtype) {
    case 'error_max_turns':
      return failure('turn_limit', MESSAGES.turnLimit, diag);
    case 'error_max_budget_usd':
      return failure('budget_limit', MESSAGES.budgetLimit, diag);
    case 'error_max_structured_output_retries':
      return failure('structured_output_limit', MESSAGES.structuredOutputLimit, diag);
    default:
      return undefined;
  }
}

/** Bounded diagnostic inference, never credential authority or a raw-text display surface. */
function textFailure(text: unknown, diag?: DiagnosticOptions): ClaudeExecutionError | undefined {
  if (typeof text !== 'string') return undefined;
  // CLI exceptions sometimes carry a result prefix; never parse process stderr here.
  const message = text.slice(0, 4096).replace(/^Claude Code returned an error result:\s*/i, '');
  const http = message.match(/^(?:API Error:|HTTP(?: status)?|status(?: code)?)\s*(\d{3})\b/i);
  const fromStatus = httpFailure(http ? Number(http[1]) : undefined, diag);
  if (fromStatus) return fromStatus;
  if (
    /^(?:Invalid API key|invalid_api_key|API key not valid|Not logged in|Please run \/login|Authentication (?:failed|is not configured)|Unauthorized|AccessDenied(?:Exception)?|UnrecognizedClient(?:Exception)?|ExpiredToken(?:Exception)?|CredentialsProviderError|Could not load credentials|AuthFailure|OAuth token (?:has )?expired)\b/i.test(
      message
    )
  ) {
    return failure('authentication', MESSAGES.authentication, diag);
  }
  if (
    /^(?:Credit balance (?:is )?too low|Insufficient credit|Balance (?:is )?exhausted)\b/i.test(
      message
    )
  ) {
    return failure('credit_exhausted', MESSAGES.creditExhausted, diag);
  }
  if (/^(?:Rate limit|Too many requests)\b/i.test(message))
    return failure('rate_limit', MESSAGES.rateLimit, diag);
  if (/^(?:Quota exceeded|insufficient_quota|ResourceExhausted)\b/i.test(message))
    return failure('quota', MESSAGES.quota, diag);
  if (/^(?:Overloaded|Service unavailable|Gateway timeout)\b/i.test(message))
    return failure('overloaded', MESSAGES.overloaded, diag);
  if (
    /^(?:fetch failed|network error|connection refused|connection reset|socket hang up)\b/i.test(
      message
    )
  )
    return failure('network', MESSAGES.network, diag);
  return limitFailure(message.split(':', 1)[0], diag);
}

/**
 * Call ONLY at Claude SDK call/iterator boundaries. Never apply this to the
 * encompassing Agor setup, persistence, callbacks or permission handling loop.
 * Abort identity and genuine MCP failures retain their existing lifecycle owners.
 */
export function sanitizeClaudeExecutionError(error: unknown): Error {
  if (isClaudeAbortError(error)) return error as Error;
  if (instanceOf(error, ClaudeExecutionError) || instanceOf(error, AgorSetupError)) return error;
  if (instanceOf(error, MCPExternalError)) return error;
  if (own(error, 'name') === 'MCPExternalError') {
    // Transported objects are not trusted instances: reconstruct fixed MCP prose.
    return asMCPExternalError(error, {
      stage: 'runtime',
      category: own(error, 'category') as MCPExternalErrorCategory,
    });
  }
  const diag = {
    cause: error,
    exitCode: exitCode(own(error, 'exitCode')),
    signal: allowed(own(error, 'signal'), SIGNALS),
    errorClass: allowed(own(error, 'errorClass'), ERROR_CLASSES),
    code: allowed(own(error, 'code'), NETWORK_CODES) ?? allowed(own(error, 'code'), PROCESS_CODES),
  };
  // Structured process failure is authoritative. Its stderr may describe an
  // unrelated MCP login or command failure; don't reinterpret that as Claude auth.
  switch (diag.errorClass) {
    case 'executable_not_found':
      return failure('process_failure', MESSAGES.executableNotFound, diag);
    case 'executable_launch_failed':
      return failure('process_failure', MESSAGES.executableLaunchFailed, diag);
    case 'spawn_failed':
    case 'process_error':
      return failure('process_failure', MESSAGES.spawnFailed, diag);
    case 'initialize_timeout':
      return failure('process_failure', MESSAGES.initializeTimeout, diag);
    case 'process_killed_by_signal':
      return failure('process_failure', MESSAGES.processSignal(diag.signal), diag);
    case 'process_exited_nonzero':
      return failure('process_failure', MESSAGES.processExit(diag.exitCode), diag);
  }
  if (diag.signal) return failure('process_failure', MESSAGES.processSignal(diag.signal), diag);
  if (diag.exitCode !== undefined && diag.exitCode !== 0)
    return failure('process_failure', MESSAGES.processExit(diag.exitCode), diag);
  const fromStatus = httpFailure(own(error, 'status') ?? own(error, 'statusCode'), diag);
  if (fromStatus) return fromStatus;
  if (diag.code && NETWORK_CODES.has(diag.code)) return failure('network', MESSAGES.network, diag);
  // Native errors may omit errorClass. ENOENT can refer to a cwd or other file,
  // so a bare code does not establish that the Claude executable is missing.
  if (diag.code && PROCESS_CODES.has(diag.code))
    return failure('process_failure', MESSAGES.processFailure, diag);
  const message = typeof error === 'string' ? error : own(error, 'message');
  // Older CLI versions lack structured process diagnostics. Restrict fallback to
  // their prefix, not numbers or credentials embedded in stderr.
  if (typeof message === 'string' && /^Claude Code process exited with code \d+\b/.test(message)) {
    return failure('process_failure', MESSAGES.processExit(), diag);
  }
  return textFailure(message, diag) ?? failure('unknown', MESSAGES.unknown, diag);
}

/** Result adapter: diagnoses without throwing, so partial output and accounting survive. */
export function classifyClaudeResultFailure(result: unknown): ClaudeExecutionError | undefined {
  const safe = projectClaudeResultResponse(result);
  if (!safe || (safe.subtype === 'success' && safe.is_error !== true)) return undefined;
  const diag = { errorClass: safe.subtype };
  const limit = limitFailure(safe.subtype, diag);
  if (limit) return limit;
  if (safe.is_error === true) {
    if (safe.subtype === 'success') {
      const inferred = textFailure(own(result, 'result'), diag);
      if (inferred) return inferred;
    } else {
      const errors = own(result, 'errors');
      // Multiple contradictory/unrecognized reasons are not a reliable diagnosis.
      // Read length as data too: a proxy/getter must not turn diagnosis into a
      // thrown failure that bypasses result accounting and cleanup.
      const length = own(errors, 'length');
      if (typeof length === 'number' && Number.isInteger(length) && length > 0 && length <= 8) {
        const diagnoses = Array.from({ length }, (_, i) =>
          textFailure(own(errors, String(i)), diag)
        );
        const first = diagnoses[0];
        if (first && diagnoses.every((item) => item?.category === first.category)) return first;
      }
    }
  }
  return failure('unknown', SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE, diag);
}
