import { describe, expect, it } from 'vitest';
import { mcpLimit, mcpOffset, mcpPositiveIntWithDefault } from './schema.js';

describe('mcpLimit', () => {
  it('applies the documented default when callers omit a limit', () => {
    expect(mcpLimit(50).parse(undefined)).toBe(50);
  });

  it('preserves permissive callers that enforce their own runtime cap', () => {
    const limit = mcpLimit(50);

    expect(limit.safeParse(500).success).toBe(true);
  });

  it('supports a lower tool-specific maximum', () => {
    const limit = mcpLimit(50, 100);

    expect(limit.safeParse(100).success).toBe(true);
    expect(limit.safeParse(101).success).toBe(false);
  });

  it('applies offset defaults consistently', () => {
    expect(mcpOffset(0).parse(undefined)).toBe(0);
  });

  it('uses the caller field name in validation errors', () => {
    const result = mcpPositiveIntWithDefault('max_results', 10).safeParse(0);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('max_results');
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid positive integer default (%s)', (defaultValue) => {
    expect(() => mcpPositiveIntWithDefault('limit', defaultValue)).toThrow(
      'default must be a positive safe integer'
    );
  });

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid positive integer maximum (%s)', (maxValue) => {
    expect(() => mcpPositiveIntWithDefault('limit', 1, maxValue)).toThrow(
      'maximum must be a positive safe integer'
    );
  });

  it('rejects a default above the maximum', () => {
    expect(() => mcpPositiveIntWithDefault('limit', 2, 1)).toThrow('exceeds maximum');
  });

  it.each([
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid offset default (%s)', (defaultValue) => {
    expect(() => mcpOffset(defaultValue)).toThrow('default must be a non-negative safe integer');
  });
});
