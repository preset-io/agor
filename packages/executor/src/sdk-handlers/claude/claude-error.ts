import { MCPExternalError } from '@agor/core/mcp';
import { MissingCredentialError } from '../../handlers/sdk/base-executor.js';

export type ClaudeExecutionErrorCategory =
  | 'authentication'
  | 'missing_credential'
  | 'credit_exhausted'
  | 'rate_limit'
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

/**
 * Error during Claude Code execution. Carries a safe user-facing message,
 * an internal category, and basic diagnostic fields for server logging.
 */
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
    this.exitCode = options?.exitCode;
    this.signal = options?.signal;
    this.errorClass = options?.errorClass;
    this.code = options?.code;
  }
}

/**
 * Specialization for missing credentials that matches Agor's base executor check.
 * Retains structured diagnostic fields for server logs.
 */
export class ClaudeMissingCredentialError extends MissingCredentialError {
  readonly category = 'missing_credential' as const;
  override readonly name = 'MissingCredentialError';
  readonly exitCode?: number;
  readonly signal?: string;
  readonly errorClass?: string;
  readonly code?: string;

  constructor(message: string, options?: DiagnosticOptions) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.exitCode = options?.exitCode;
    this.signal = options?.signal;
    this.errorClass = options?.errorClass;
    this.code = options?.code;
  }
}

export type ClaudeDiagnosticError = ClaudeExecutionError | ClaudeMissingCredentialError;

export function isClaudeDiagnosticError(error: unknown): error is ClaudeDiagnosticError {
  return error instanceof ClaudeExecutionError || error instanceof ClaudeMissingCredentialError;
}

export class AgorSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgorSetupError';
  }
}

export function isAgorSetupError(error: unknown): error is AgorSetupError {
  return error instanceof AgorSetupError;
}

/**
 * Detects an abort thrown by the Claude SDK ({ errorClass: 'aborted' }).
 * Handled structurally rather than via instanceof since SDK may be loaded dynamically.
 */
export function isClaudeAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { errorClass?: unknown }).errorClass === 'aborted'
  );
}

export function logClaudeFailure(
  label: string,
  safe: unknown,
  extra?: Record<string, unknown>
): void {
  const isClaude = isClaudeDiagnosticError(safe);
  const category =
    safe && typeof safe === 'object' && 'category' in safe
      ? (safe as { category: unknown }).category
      : isAgorSetupError(safe)
        ? 'setup_error'
        : undefined;

  const message =
    safe instanceof Error ? safe.message : typeof safe === 'string' ? safe : undefined;

  console.error(label, {
    ...extra,
    category,
    message,
    errorClass: isClaude ? safe.errorClass : undefined,
    exitCode: isClaude ? safe.exitCode : undefined,
    signal: isClaude ? safe.signal : undefined,
    code: isClaude ? safe.code : undefined,
  });
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

export const MESSAGES = {
  authentication:
    'Claude Code authentication failed. Check your API key or provider credentials in Settings → Claude Code authentication.',
  forbidden:
    'Claude Code authentication failed (HTTP 403). Check your API key or provider credentials in Settings → Claude Code authentication, or that your account has access.',
  missingCredential:
    'Claude Code authentication is not configured. Please sign in or provide an API key.',
  creditExhausted:
    'Claude Code credit balance is too low. Please top up your Anthropic account credits.',
  rateLimit: 'Claude Code rate limit reached. Please wait before retrying your request.',
  overloaded:
    'Claude Code is currently overloaded or temporarily unavailable. Please retry shortly.',
  unavailable: 'Claude Code is temporarily unavailable. Please retry shortly.',
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
  processSignal: (signal?: string) =>
    signal
      ? `Claude Code process was terminated by signal ${signal}.`
      : 'Claude Code process was terminated by a signal.',
  processExit: (exitCode?: number) =>
    exitCode
      ? `Claude Code process exited unexpectedly (code ${exitCode}). Retry your request, or check the logs if the issue persists.`
      : 'Claude Code process exited unexpectedly. Retry your request, or check the logs if the issue persists.',
  unknown:
    'Claude Code execution failed. Retry your request, or check the operational logs if the issue persists.',
} as const;

const VALID_MCP_CATEGORIES = new Set([
  'provider_unavailable',
  'provider_rejected',
  'invalid_response',
  'storage_policy_rejected',
  'configuration_required',
  'unknown',
]);

export function sanitizeClaudeExecutionError(
  error: unknown
): ClaudeExecutionError | ClaudeMissingCredentialError | MCPExternalError | AgorSetupError {
  // 1. Passthrough genuine or valid duck-typed MCPExternalErrors
  if (error instanceof MCPExternalError) return error;
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  if (
    record.name === 'MCPExternalError' &&
    typeof record.category === 'string' &&
    VALID_MCP_CATEGORIES.has(record.category) &&
    record.diagnostic &&
    typeof record.diagnostic === 'object'
  ) {
    return error as MCPExternalError;
  }

  // 2. Already sanitized errors
  if (error instanceof ClaudeExecutionError || error instanceof ClaudeMissingCredentialError) {
    return error;
  }
  if (isAgorSetupError(error)) return error;

  // 3. Extract basic diagnostic fields inline
  const errorClass = typeof record.errorClass === 'string' ? record.errorClass : undefined;
  const signal = typeof record.signal === 'string' ? record.signal : undefined;
  const code = typeof record.code === 'string' ? record.code : undefined;

  const rawStatus = record.status ?? record.statusCode;
  const status =
    typeof rawStatus === 'number' &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 100 &&
    rawStatus <= 599
      ? rawStatus
      : typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus.trim())
        ? Number(rawStatus.trim())
        : undefined;

  let exitCode =
    typeof record.exitCode === 'number' && Number.isInteger(record.exitCode)
      ? record.exitCode
      : typeof record.exitCode === 'string' && /^\d{1,3}$/.test(record.exitCode.trim())
        ? Number(record.exitCode.trim())
        : undefined;

  const rawMessage =
    error instanceof Error
      ? error.message || ''
      : typeof error === 'string'
        ? error
        : typeof record.message === 'string'
          ? record.message
          : '';

  if (exitCode === undefined) {
    const match = rawMessage.match(/exited with (?:non-zero )?code (\d{1,3})/i);
    if (match?.[1]) exitCode = Number(match[1]);
  }

  const diag = { cause: error, exitCode, signal, errorClass, code };

  // 4. Missing credential error from base executor
  if (error instanceof MissingCredentialError) {
    return new ClaudeMissingCredentialError(error.message || MESSAGES.missingCredential, diag);
  }

  // 5. Explicit SDK startup errorClasses
  if (errorClass === 'executable_not_found') {
    return new ClaudeExecutionError('process_failure', MESSAGES.executableNotFound, diag);
  }
  if (errorClass === 'executable_launch_failed') {
    return new ClaudeExecutionError('process_failure', MESSAGES.executableLaunchFailed, diag);
  }
  if (errorClass === 'spawn_failed' || errorClass === 'process_error') {
    return new ClaudeExecutionError('process_failure', MESSAGES.spawnFailed, diag);
  }
  if (errorClass === 'initialize_timeout') {
    return new ClaudeExecutionError('process_failure', MESSAGES.initializeTimeout, diag);
  }
  if (errorClass === 'process_killed_by_signal' || signal) {
    return new ClaudeExecutionError('process_failure', MESSAGES.processSignal(signal), diag);
  }

  if (code && NETWORK_ERROR_CODES.has(code)) {
    return new ClaudeExecutionError('network', MESSAGES.network, diag);
  }

  const msg = rawMessage.toLowerCase();

  // 6. Structured HTTP status codes (authoritative from API client / provider)
  if (status === 403) {
    return new ClaudeExecutionError('authentication', MESSAGES.forbidden, diag);
  }
  if (status === 401) {
    return new ClaudeExecutionError('authentication', MESSAGES.authentication, diag);
  }
  if (status === 429) {
    if (msg.includes('credit balance') || msg.includes('insufficient_quota')) {
      return new ClaudeExecutionError('credit_exhausted', MESSAGES.creditExhausted, diag);
    }
    return new ClaudeExecutionError('rate_limit', MESSAGES.rateLimit, diag);
  }
  if (status === 500 || status === 502) {
    return new ClaudeExecutionError('overloaded', MESSAGES.unavailable, diag);
  }
  if (status === 503 || status === 504 || status === 529) {
    return new ClaudeExecutionError('overloaded', MESSAGES.overloaded, diag);
  }

  // 7. Authentication MUST precede missing credentials.
  // Provider-rejected credentials (401, 403, invalid key, IAM errors) must instruct the user
  // to check their credentials, rather than falsely prompting them to sign in.
  if (
    msg.includes('403 forbidden') ||
    /\b(?:http(?: status)?|status(?: code)?|api error)\s*:?\s*403\b/.test(msg)
  ) {
    return new ClaudeExecutionError('authentication', MESSAGES.forbidden, diag);
  }

  if (
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('api key not valid') ||
    msg.includes('fix external api key') ||
    msg.includes('401 unauthorized') ||
    /\b(?:http(?: status)?|status(?: code)?|api error)\s*:?\s*401\b/.test(msg) ||
    /accessdenied|unrecognizedclient|expiredtoken|credentialsprovidererror|could not load credentials|authfailure/.test(
      msg
    )
  ) {
    return new ClaudeExecutionError('authentication', MESSAGES.authentication, diag);
  }

  // 8. Missing credentials
  if (
    msg.includes('not logged in') ||
    msg.includes('please run /login') ||
    msg.includes('authentication is not configured')
  ) {
    return new ClaudeMissingCredentialError(MESSAGES.missingCredential, diag);
  }

  // 9. Quota & Credit
  if (
    msg.includes('credit balance') ||
    msg.includes('insufficient_quota') ||
    msg.includes('balance is exhausted') ||
    msg.includes('balance exhausted')
  ) {
    return new ClaudeExecutionError('credit_exhausted', MESSAGES.creditExhausted, diag);
  }

  // 10. Rate limiting
  if (
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    /\b(?:http(?: status)?|status(?: code)?|api error)\s*:?\s*429\b/.test(msg)
  ) {
    return new ClaudeExecutionError('rate_limit', MESSAGES.rateLimit, diag);
  }

  // 11. Overloaded / server availability
  if (
    msg.includes('500 internal server error') ||
    msg.includes('502 bad gateway') ||
    /\b(?:http(?: status)?|status(?: code)?|api error)\s*:?\s*(?:500|502)\b/.test(msg)
  ) {
    return new ClaudeExecutionError('overloaded', MESSAGES.unavailable, diag);
  }
  if (
    msg.includes('overloaded') ||
    msg.includes('service unavailable') ||
    msg.includes('gateway timeout') ||
    /\b(?:http(?: status)?|status(?: code)?|api error)\s*:?\s*(?:503|504|529)\b/.test(msg)
  ) {
    return new ClaudeExecutionError('overloaded', MESSAGES.overloaded, diag);
  }

  // 12. Execution limits
  if (msg.includes('error_max_turns') || msg.includes('turn limit')) {
    return new ClaudeExecutionError('turn_limit', MESSAGES.turnLimit, diag);
  }
  if (msg.includes('error_max_budget_usd') || msg.includes('budget limit')) {
    return new ClaudeExecutionError('budget_limit', MESSAGES.budgetLimit, diag);
  }
  if (msg.includes('error_max_structured_output_retries')) {
    return new ClaudeExecutionError(
      'structured_output_limit',
      MESSAGES.structuredOutputLimit,
      diag
    );
  }

  // 13. Network failures
  if (
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('connection refused') ||
    msg.includes('connection reset') ||
    msg.includes('socket hang up') ||
    msg.includes('timed out') ||
    msg.includes('timeout')
  ) {
    return new ClaudeExecutionError('network', MESSAGES.network, diag);
  }

  // 14. Process failures (exit code non-zero without more specific message)
  if (
    errorClass === 'process_exited_nonzero' ||
    (exitCode !== undefined && exitCode !== 0) ||
    /\bprocess exited with (?:non-zero )?code (?!0\b)\d+/i.test(rawMessage)
  ) {
    return new ClaudeExecutionError('process_failure', MESSAGES.processExit(exitCode), diag);
  }

  return new ClaudeExecutionError('unknown', MESSAGES.unknown, diag);
}
