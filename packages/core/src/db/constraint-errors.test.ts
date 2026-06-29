import { describe, expect, it } from 'vitest';
import { isUniqueConstraintError } from './constraint-errors';

describe('isUniqueConstraintError', () => {
  it('detects postgres and sqlite unique constraint errors', () => {
    expect(isUniqueConstraintError({ code: '23505' })).toBe(true);
    expect(isUniqueConstraintError({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true);
    expect(isUniqueConstraintError({ cause: { code: 'SQLITE_CONSTRAINT' } })).toBe(true);
    expect(isUniqueConstraintError(new Error('UNIQUE constraint failed: links.target_key'))).toBe(
      true
    );
  });

  it('does not match unrelated errors', () => {
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError({ code: '23503' })).toBe(false);
    expect(isUniqueConstraintError(new Error('FOREIGN KEY constraint failed'))).toBe(false);
  });
});
