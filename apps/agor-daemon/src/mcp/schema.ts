import { z } from 'zod';

type RequiredStringOptions = {
  /** Example object or field value to include in validation failures. */
  example?: string;
};

function suffixExample(example: string | undefined): string {
  return example ? ` Example: ${example}` : '';
}

/**
 * Required non-empty string for MCP tool inputs.
 *
 * Prefer this over bare `z.string()` for required tool arguments so malformed
 * MCP calls fail with caller-oriented messages instead of raw Zod type text.
 */
export function mcpRequiredString(
  fieldName: string,
  description: string,
  options: RequiredStringOptions = {}
) {
  return z
    .string({
      error: `${fieldName} is required and must be a string.${suffixExample(options.example)}`,
    })
    .min(1, `${fieldName} cannot be empty.${suffixExample(options.example)}`)
    .describe(description);
}

/**
 * Optional string with a caller-oriented wrong-type error.
 */
export function mcpOptionalString(fieldName: string, description: string) {
  return z
    .string({
      error: `${fieldName} must be a string when provided.`,
    })
    .optional()
    .describe(description);
}

/**
 * Optional string that must be non-empty when present. Use for optional
 * labels/titles/names where an empty string is almost always an accidental
 * malformed MCP call rather than an intentional clear operation.
 */
export function mcpOptionalNonEmptyString(fieldName: string, description: string) {
  return z
    .string({
      error: `${fieldName} must be a string when provided.`,
    })
    .min(1, `${fieldName} cannot be empty when provided.`)
    .optional()
    .describe(description);
}

/**
 * Optional string that must contain non-whitespace text when present.
 */
export function mcpOptionalNonBlankString(fieldName: string, description: string) {
  return z
    .string({
      error: `${fieldName} must be a string when provided.`,
    })
    .refine((value) => value.trim().length > 0, `${fieldName} cannot be blank when provided.`)
    .optional()
    .describe(description);
}

export function mcpRequiredId(fieldName: string, entityName: string, description?: string) {
  return mcpRequiredString(fieldName, description ?? `${entityName} ID (UUIDv7 or short ID)`, {
    example: `{ "${fieldName}": "01abcdef" }`,
  });
}

export function mcpOptionalId(fieldName: string, entityName: string, description?: string) {
  return z
    .string({
      error: `${fieldName} must be a string when provided.`,
    })
    .min(1, `${fieldName} cannot be empty when provided.`)
    .optional()
    .describe(description ?? `${entityName} ID (UUIDv7 or short ID)`);
}

export function mcpOptionalNumber(fieldName: string, description: string) {
  return z
    .number({
      error: `${fieldName} must be a number when provided.`,
    })
    .optional()
    .describe(description);
}

export function mcpRequiredNumber(fieldName: string, description: string) {
  return z
    .number({
      error: `${fieldName} is required and must be a number.`,
    })
    .describe(description);
}

export function mcpRequiredPositiveInt(fieldName: string, description: string) {
  return z
    .number({
      error: `${fieldName} is required and must be a positive integer.`,
    })
    .int(`${fieldName} must be an integer.`)
    .positive(`${fieldName} must be greater than 0.`)
    .describe(description);
}

export function mcpOptionalPositiveInt(fieldName: string, description: string) {
  return z
    .number({
      error: `${fieldName} must be a positive integer when provided.`,
    })
    .int(`${fieldName} must be an integer.`)
    .positive(`${fieldName} must be greater than 0.`)
    .optional()
    .describe(description);
}

export function mcpOptionalNonNegativeInt(fieldName: string, description: string) {
  return z
    .number({
      error: `${fieldName} must be a non-negative integer when provided.`,
    })
    .int(`${fieldName} must be an integer.`)
    .nonnegative(`${fieldName} must be greater than or equal to 0.`)
    .optional()
    .describe(description);
}

export function mcpPositiveIntWithDefault(
  fieldName: string,
  defaultValue: number,
  maxValue?: number
) {
  if (!Number.isSafeInteger(defaultValue) || defaultValue <= 0) {
    throw new Error(`MCP ${fieldName} default must be a positive safe integer`);
  }
  if (maxValue !== undefined && (!Number.isSafeInteger(maxValue) || maxValue <= 0)) {
    throw new Error(`MCP ${fieldName} maximum must be a positive safe integer`);
  }
  if (maxValue !== undefined && defaultValue > maxValue) {
    throw new Error(`MCP ${fieldName} default ${defaultValue} exceeds maximum ${maxValue}`);
  }

  const limit = z
    .number({
      error: `${fieldName} must be a positive integer when provided.`,
    })
    .int(`${fieldName} must be an integer.`)
    .positive(`${fieldName} must be greater than 0.`);
  const boundedLimit =
    maxValue === undefined
      ? limit
      : limit.max(maxValue, `${fieldName} must be less than or equal to ${maxValue}.`);

  return boundedLimit.optional().default(defaultValue);
}

export function mcpLimit(defaultValue = 50, maxValue?: number) {
  return mcpPositiveIntWithDefault('limit', defaultValue, maxValue).describe(
    `Maximum number of results (default: ${defaultValue}${
      maxValue === undefined ? '' : `, max: ${maxValue}`
    })`
  );
}

export function mcpOffset(defaultValue = 0) {
  if (!Number.isSafeInteger(defaultValue) || defaultValue < 0) {
    throw new Error('MCP offset default must be a non-negative safe integer');
  }

  return z
    .number({
      error: 'offset must be a non-negative integer when provided.',
    })
    .int('offset must be an integer.')
    .nonnegative('offset must be greater than or equal to 0.')
    .optional()
    .default(defaultValue)
    .describe(`Number of results to skip (default: ${defaultValue})`);
}
