import { ENV_VAR_NAME_PATTERN, MAX_ENV_VAR_VALUE_BYTES } from './env-blocklist';

/**
 * Validation constraints for environment variables
 */
export const ENV_VAR_CONSTRAINTS = {
  /** Maximum value length in bytes */
  MAX_VALUE_LENGTH: MAX_ENV_VAR_VALUE_BYTES,

  /** Regex for valid variable names (uppercase, underscore, numbers) */
  NAME_PATTERN: ENV_VAR_NAME_PATTERN,
};

/**
 * Validation error result
 */
export interface ValidationError {
  field: 'name' | 'value';
  code: 'invalid_format' | 'invalid_character' | 'empty_value' | 'too_long' | 'missing_field';
  message: string;
}

/**
 * Validate environment variable name and value
 *
 * @param name - Variable name to validate
 * @param value - Variable value to validate (optional if only validating name)
 * @returns Array of validation errors, or empty array if valid
 */
export function validateEnvVar(name: string, value?: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Validate name presence
  if (!name) {
    errors.push({
      field: 'name',
      code: 'missing_field',
      message: 'Environment variable name is required',
    });
    return errors;
  }

  // Validate name format (must be uppercase with underscores/numbers)
  if (!ENV_VAR_CONSTRAINTS.NAME_PATTERN.test(name)) {
    errors.push({
      field: 'name',
      code: 'invalid_format',
      message: `Variable name must match pattern: ${ENV_VAR_CONSTRAINTS.NAME_PATTERN.source} (e.g., GITHUB_TOKEN, AWS_ACCESS_KEY_ID)`,
    });
  }

  // Validate value if provided
  if (value !== undefined) {
    if (value === null) {
      // null is allowed (means clear/delete)
      return errors;
    }

    // Validate value is not empty
    if (value === '' || !value.trim()) {
      errors.push({
        field: 'value',
        code: 'empty_value',
        message: 'Environment variable value cannot be empty',
      });
    }

    // Node rejects NUL-containing environment values at spawn time. Reject at
    // ingress as well as at the final executor boundary so one malformed value
    // cannot turn every future task/lifecycle action into a deterministic DoS.
    if (value.includes('\0')) {
      errors.push({
        field: 'value',
        code: 'invalid_character',
        message: 'Environment variable value cannot contain a NUL character',
      });
    }

    // Validate value length
    const valueBytes = Buffer.byteLength(value, 'utf-8');
    if (valueBytes > ENV_VAR_CONSTRAINTS.MAX_VALUE_LENGTH) {
      errors.push({
        field: 'value',
        code: 'too_long',
        message: `Variable value exceeds maximum size of ${ENV_VAR_CONSTRAINTS.MAX_VALUE_LENGTH / 1024}KB (${Math.ceil(valueBytes / 1024)}KB provided)`,
      });
    }
  }

  return errors;
}

/**
 * Check if validation passed
 */
export function isValid(errors: ValidationError[]): boolean {
  return errors.length === 0;
}

/**
 * Get formatted error message for display
 */
export function formatValidationError(error: ValidationError): string {
  return error.message;
}

/**
 * Get all validation errors as formatted string (for logging)
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return '';
  return errors.map((e) => `[${e.field}] ${e.message}`).join('\n');
}
