/**
 * Closed, value-free classification for failures originating outside Agor's
 * MCP trust boundary. Provider and library exceptions are untrusted input:
 * DNS clients, TLS stacks, redirect handlers, and SDKs routinely include the
 * requested URL or reflected response text in `message`.
 */

export const MCP_EXTERNAL_ERROR_STAGES = [
  'jwt',
  'oauth',
  'oauth_metadata',
  'oauth_callback',
  'discovery',
  'runtime',
] as const;

export type MCPExternalErrorStage = (typeof MCP_EXTERNAL_ERROR_STAGES)[number];
export type MCPExternalErrorCategory =
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'invalid_response'
  | 'configuration_required'
  | 'unknown';
export type MCPExternalErrorAction = 'retry' | 'reauthenticate' | 'review_configuration';
export type MCPExternalErrorType = 'Error' | 'TypeError' | 'AbortError' | 'UnknownError';

const ALLOWED_EXTERNAL_CODES = new Set([
  'ABORT_ERR',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_RESPONSE_STATUS_CODE',
]);

export interface SanitizedMCPExternalError {
  category: MCPExternalErrorCategory;
  action: MCPExternalErrorAction;
  /** Fixed prose. It never incorporates exception, endpoint, or provider text. */
  message: string;
  /** Closed metadata safe for ordinary operational logs. */
  diagnostic: {
    event: 'mcp_external_failure';
    stage: MCPExternalErrorStage;
    type: MCPExternalErrorType;
    code?: string;
  };
}

// Nominal identity for errors created by this module. Unlike `instanceof`, a
// WeakSet lookup does not execute a hostile Proxy's getPrototypeOf trap.
const trustedMCPExternalErrors = new WeakSet<object>();

export class MCPExternalError extends Error {
  readonly category: MCPExternalErrorCategory;
  readonly action: MCPExternalErrorAction;
  readonly diagnostic: SanitizedMCPExternalError['diagnostic'];

  constructor(sanitized: SanitizedMCPExternalError) {
    const category = safeCategory(sanitized.category);
    const contract = fixedContract(category);
    super(contract.message);
    this.name = 'MCPExternalError';
    this.category = category;
    this.action = contract.action;
    this.diagnostic = {
      event: 'mcp_external_failure',
      stage: safeStage(sanitized.diagnostic?.stage),
      type: safeDiagnosticType(sanitized.diagnostic?.type),
      ...(safeAllowedCode(sanitized.diagnostic?.code)
        ? { code: safeAllowedCode(sanitized.diagnostic?.code) }
        : {}),
    };
    trustedMCPExternalErrors.add(this);
  }
}

function safeCategory(category: unknown): MCPExternalErrorCategory {
  return category === 'provider_unavailable' ||
    category === 'provider_rejected' ||
    category === 'invalid_response' ||
    category === 'configuration_required' ||
    category === 'unknown'
    ? category
    : 'unknown';
}

function safeStage(stage: unknown): MCPExternalErrorStage {
  return typeof stage === 'string' &&
    MCP_EXTERNAL_ERROR_STAGES.includes(stage as MCPExternalErrorStage)
    ? (stage as MCPExternalErrorStage)
    : 'runtime';
}

function safeDiagnosticType(type: unknown): MCPExternalErrorType {
  return type === 'Error' ||
    type === 'TypeError' ||
    type === 'AbortError' ||
    type === 'UnknownError'
    ? type
    : 'UnknownError';
}

function safeAllowedCode(code: unknown): string | undefined {
  return typeof code === 'string' && ALLOWED_EXTERNAL_CODES.has(code) ? code : undefined;
}

function safeInstanceOf(
  error: unknown,
  errorClass: typeof Error | typeof TypeError | typeof DOMException
): boolean {
  try {
    return error instanceof errorClass;
  } catch {
    return false;
  }
}

function isTrustedDOMAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'function' || !safeInstanceOf(error, DOMException)) return false;
  try {
    // Invoke only the platform-owned DOMException accessor. Reading
    // `error.name` directly could execute an attacker-controlled getter.
    const descriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name');
    return descriptor?.get?.call(error) === 'AbortError';
  } catch {
    return false;
  }
}

function safeOwnDataValue(error: unknown, property: string): unknown {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, property);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Abort recognition which never invokes an attacker-controlled `name` getter.
 * SDKs commonly construct `Error` and assign an own data `name`, while web
 * AbortErrors also expose the closed `ABORT_ERR` code.
 */
export function isMCPAbortError(error: unknown): boolean {
  if (safeCode(error) === 'ABORT_ERR') return true;
  if (safeOwnDataValue(error, 'name') === 'AbortError') return true;
  return isTrustedDOMAbortError(error);
}

function safeType(error: unknown): MCPExternalErrorType {
  if (isMCPAbortError(error)) return 'AbortError';
  if (safeInstanceOf(error, TypeError)) return 'TypeError';
  if (safeInstanceOf(error, Error)) return 'Error';
  return 'UnknownError';
}

function safeCode(error: unknown): string | undefined {
  return safeAllowedCode(safeOwnDataValue(error, 'code'));
}

function fixedContract(
  category: MCPExternalErrorCategory
): Pick<SanitizedMCPExternalError, 'action' | 'message'> {
  switch (category) {
    case 'provider_unavailable':
      return {
        action: 'retry',
        message:
          'The MCP or OAuth provider is temporarily unreachable. Check the saved configuration and retry.',
      };
    case 'provider_rejected':
      return {
        action: 'reauthenticate',
        message:
          'The provider rejected the MCP authentication request. Review the saved credentials or sign in again.',
      };
    case 'invalid_response':
      return {
        action: 'retry',
        message:
          'The provider returned an invalid MCP response. Retry, then review the provider configuration.',
      };
    case 'configuration_required':
      return {
        action: 'review_configuration',
        message:
          'This MCP authentication configuration is incomplete. Review the saved server settings and retry.',
      };
    default:
      return {
        action: 'retry',
        message:
          'The MCP operation failed. Retry, then ask an administrator to review the secure operational event if it continues.',
      };
  }
}

/**
 * Classify untrusted external failures without consulting `message`, `stack`,
 * `cause`, response bodies, URLs, or other attacker/provider-controlled data.
 */
export function sanitizeMCPExternalError(
  error: unknown,
  options: {
    stage: MCPExternalErrorStage;
    category?: MCPExternalErrorCategory;
  }
): SanitizedMCPExternalError {
  if (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    trustedMCPExternalErrors.has(error)
  ) {
    try {
      const category = safeCategory(safeOwnDataValue(error, 'category'));
      const contract = fixedContract(category);
      const diagnostic = safeOwnDataValue(error, 'diagnostic');
      const code = safeAllowedCode(safeOwnDataValue(diagnostic, 'code'));
      return {
        category,
        ...contract,
        diagnostic: {
          event: 'mcp_external_failure',
          stage: safeStage(options.stage),
          type: safeDiagnosticType(safeOwnDataValue(diagnostic, 'type')),
          ...(code ? { code } : {}),
        },
      };
    } catch {
      // Nominal instances use own data fields, but retain the generic fallback
      // if memory corruption or a future implementation changes that contract.
    }
  }

  const code = safeCode(error);
  const type = safeType(error);
  const category = safeCategory(
    options.category ??
      (code || type === 'TypeError' || type === 'AbortError' ? 'provider_unavailable' : 'unknown')
  );
  const contract = fixedContract(category);
  return {
    category,
    ...contract,
    diagnostic: {
      event: 'mcp_external_failure',
      stage: safeStage(options.stage),
      type,
      ...(code ? { code } : {}),
    },
  };
}

/** Turn an unknown provider/library exception into a safe throwable. */
export function asMCPExternalError(
  error: unknown,
  options: Parameters<typeof sanitizeMCPExternalError>[1]
): MCPExternalError {
  return new MCPExternalError(sanitizeMCPExternalError(error, options));
}
