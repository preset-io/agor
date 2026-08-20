export interface SafeIntegerRangeOptions {
  defaultValue: number;
  minimum: number;
  maximum?: number;
  path: string;
}

/** Resolve one optional config integer while enforcing an inclusive safe range. */
export function resolveSafeIntegerInRange(
  value: number | undefined,
  options: SafeIntegerRangeOptions
): number {
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  const resolved = value ?? options.defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < options.minimum || resolved > maximum) {
    throw new Error(
      `Config error: ${options.path} must be a safe integer between ${options.minimum} and ${maximum}`
    );
  }
  return resolved;
}
