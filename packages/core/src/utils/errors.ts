/**
 * Error utilities for consistent error handling across Agor
 *
 * Provides standardized error formatting, logging, and categorization.
 * Used by daemon services and API handlers for uniform error responses.
 */

/**
 * Custom error classes for type-safe error handling
 */

/**
 * Base class for all Agor errors
 */
export class AgorError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = this.constructor.name;
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when a resource is not found in the database
 */
export class NotFoundError extends AgorError {
  constructor(resourceType: string, id: string) {
    super(`${resourceType} not found: ${id}`, 'NOT_FOUND');
    this.resourceType = resourceType;
    this.id = id;
  }

  public readonly resourceType: string;
  public readonly id: string;
}

/**
 * Thrown when a resource already exists
 */
export class AlreadyExistsError extends AgorError {
  constructor(resourceType: string, identifier: string) {
    super(`${resourceType} already exists: ${identifier}`, 'ALREADY_EXISTS');
  }
}

/**
 * Thrown when validation fails
 */
export class ValidationError extends AgorError {
  constructor(message: string, public readonly field?: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

/**
 * Thrown when an operation is not authorized
 */
export class UnauthorizedError extends AgorError {
  constructor(message: string = 'Not authorized') {
    super(message, 'UNAUTHORIZED');
  }
}

/**
 * Extract error message from any value
 * Handles Error objects, strings, and unknown types
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

/**
 * Get full error details including stack trace
 * Useful for logging but not for client responses
 */
export function getErrorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: getErrorMessage(error),
  };
}

/**
 * Format error for user-facing output (no stack traces)
 * Safe to return to clients
 */
export function formatUserError(error: unknown): string {
  const message = getErrorMessage(error);

  // Remove sensitive details from error messages
  return message
    .replace(/\/[\w\/]+\.ts:\d+/g, '[source]') // Remove file paths
    .replace(/^Error: /, '') // Remove redundant "Error:" prefix
    .trim();
}

/**
 * Check if error is a known type of error
 */
export function isBusinessLogicError(error: unknown): boolean {
  if (error instanceof Error) {
    // Common business logic error patterns
    return (
      error.message.includes('not found') ||
      error.message.includes('already exists') ||
      error.message.includes('invalid') ||
      error.message.includes('not authorized')
    );
  }
  return false;
}

/**
 * Safe error handler for promise rejections
 * Returns formatted error with logging
 */
export function handlePromiseError(
  error: unknown,
  context: string,
  options: { logFull?: boolean; throwError?: boolean } = {}
): string {
  const { logFull = false, throwError = false } = options;
  const message = getErrorMessage(error);

  if (logFull) {
    const details = getErrorDetails(error);
    console.error(`❌ [${context}] ${details.message}`, details.stack);
  } else {
    console.error(`❌ [${context}] ${message}`);
  }

  if (throwError) {
    throw error;
  }

  return formatUserError(error);
}

/**
 * Create a standardized error response for APIs
 */
export function createErrorResponse(
  error: unknown,
  defaultMessage: string = 'An error occurred'
): {
  success: false;
  error: string;
  timestamp: string;
} {
  return {
    success: false,
    error: formatUserError(error) || defaultMessage,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Log error with context information
 * Used by services and hooks
 */
export function logError(
  error: unknown,
  context: string,
  metadata: Record<string, unknown> = {}
): void {
  const details = getErrorDetails(error);
  const metadataStr = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : '';

  console.error(`❌ [${context}] ${details.message} ${metadataStr}`.trim());

  if (process.env.NODE_ENV === 'development' && details.stack) {
    console.error(details.stack);
  }
}
