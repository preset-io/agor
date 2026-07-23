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
});
