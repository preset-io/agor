/**
 * Type Utilities Tests
 *
 * Tests for runtime utility functions in types/utils.ts
 */

import { describe, expect, it } from 'vitest';
import { isDefined, isNonEmptyString } from './utils';

// ============================================================================
// isDefined
// ============================================================================

describe('isDefined', () => {
  it('should return true for non-null, non-undefined values', () => {
    expect(isDefined(0)).toBe(true);
    expect(isDefined(1)).toBe(true);
    expect(isDefined(-1)).toBe(true);
    expect(isDefined('')).toBe(true);
    expect(isDefined('hello')).toBe(true);
    expect(isDefined(false)).toBe(true);
    expect(isDefined(true)).toBe(true);
    expect(isDefined({})).toBe(true);
    expect(isDefined([])).toBe(true);
    expect(isDefined({ key: 'value' })).toBe(true);
    expect(isDefined([1, 2, 3])).toBe(true);
  });

  it('should return false for null', () => {
    expect(isDefined(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isDefined(undefined)).toBe(false);
  });

  it('should handle edge case values', () => {
    expect(isDefined(NaN)).toBe(true); // NaN is defined (it's a number)
    expect(isDefined(Infinity)).toBe(true);
    expect(isDefined(-Infinity)).toBe(true);
    expect(isDefined(0n)).toBe(true); // BigInt
  });

  it('should work as array filter to remove null/undefined', () => {
    const input = [1, null, 2, undefined, 3, null, 4];
    const result = input.filter(isDefined);

    expect(result).toEqual([1, 2, 3, 4]);
    // TypeScript should infer result as number[]
  });

  it('should work with mixed type arrays', () => {
    const input: Array<string | null | undefined> = ['a', null, 'b', undefined, 'c'];
    const result = input.filter(isDefined);

    expect(result).toEqual(['a', 'b', 'c']);
    // TypeScript should infer result as string[]
  });

  it('should work with object arrays', () => {
    const input = [{ id: 1 }, null, { id: 2 }, undefined, { id: 3 }];
    const result = input.filter(isDefined);

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('should preserve empty strings and zero values', () => {
    const input = [0, '', false, null, undefined];
    const result = input.filter(isDefined);

    expect(result).toEqual([0, '', false]);
  });

  it('should work with function values', () => {
    const fn = () => 'test';
    expect(isDefined(fn)).toBe(true);
  });

  it('should work with symbol values', () => {
    const sym = Symbol('test');
    expect(isDefined(sym)).toBe(true);
  });

  it('should work with date objects', () => {
    const date = new Date();
    expect(isDefined(date)).toBe(true);
  });

  it('should work with regex objects', () => {
    const regex = /test/;
    expect(isDefined(regex)).toBe(true);
  });

  it('should handle complex nested objects', () => {
    const obj = {
      nested: {
        deeply: {
          value: 42,
        },
      },
    };
    expect(isDefined(obj)).toBe(true);
  });

  it('should work in conditional chains', () => {
    const value: string | null | undefined = 'test';

    if (isDefined(value)) {
      // TypeScript should know value is string here
      expect(value.length).toBe(4);
    }
  });
});

// ============================================================================
// isNonEmptyString
// ============================================================================

describe('isNonEmptyString', () => {
  it('should return true for non-empty strings', () => {
    expect(isNonEmptyString('hello')).toBe(true);
    expect(isNonEmptyString('a')).toBe(true);
    expect(isNonEmptyString('test string')).toBe(true);
    expect(isNonEmptyString('123')).toBe(true);
    expect(isNonEmptyString('!@#$%')).toBe(true);
  });

  it('should return false for empty strings', () => {
    expect(isNonEmptyString('')).toBe(false);
  });

  it('should return false for whitespace-only strings', () => {
    expect(isNonEmptyString(' ')).toBe(false);
    expect(isNonEmptyString('  ')).toBe(false);
    expect(isNonEmptyString('\t')).toBe(false);
    expect(isNonEmptyString('\n')).toBe(false);
    expect(isNonEmptyString('\r')).toBe(false);
    expect(isNonEmptyString(' \t\n\r ')).toBe(false);
  });

  it('should return true for strings with content and surrounding whitespace', () => {
    expect(isNonEmptyString(' hello ')).toBe(true);
    expect(isNonEmptyString('\thello\t')).toBe(true);
    expect(isNonEmptyString('\nhello\n')).toBe(true);
    expect(isNonEmptyString('  a  ')).toBe(true);
  });

  it('should return false for non-string types', () => {
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(0)).toBe(false);
    expect(isNonEmptyString(1)).toBe(false);
    expect(isNonEmptyString(false)).toBe(false);
    expect(isNonEmptyString(true)).toBe(false);
    expect(isNonEmptyString({})).toBe(false);
    expect(isNonEmptyString([])).toBe(false);
    expect(isNonEmptyString(['hello'])).toBe(false);
  });

  it('should work as array filter to remove empty/whitespace strings', () => {
    const input = ['', 'Alice', '  ', 'Bob', '\t', 'Charlie', '\n'];
    const result = input.filter(isNonEmptyString);

    expect(result).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('should filter mixed type arrays', () => {
    const input: Array<string | number | null | undefined> = [
      '',
      'valid',
      null,
      'another',
      0,
      '  ',
      'last',
      undefined,
    ];
    const result = input.filter(isNonEmptyString);

    expect(result).toEqual(['valid', 'another', 'last']);
  });

  it('should handle unicode and emoji strings', () => {
    expect(isNonEmptyString('👤')).toBe(true);
    expect(isNonEmptyString('⭐')).toBe(true);
    expect(isNonEmptyString('日本語')).toBe(true);
    expect(isNonEmptyString('مرحبا')).toBe(true);
    expect(isNonEmptyString('Ñoño')).toBe(true);
  });

  it('should handle special characters', () => {
    expect(isNonEmptyString('\u0000')).toBe(true); // null character
    expect(isNonEmptyString('\u200B')).toBe(true); // zero-width space (not trimmed by trim())
  });

  it('should handle strings with line breaks and content', () => {
    expect(isNonEmptyString('line1\nline2')).toBe(true);
    expect(isNonEmptyString('a\tb')).toBe(true);
    expect(isNonEmptyString('text\r\nmore text')).toBe(true);
  });

  it('should handle numeric strings', () => {
    expect(isNonEmptyString('0')).toBe(true);
    expect(isNonEmptyString('-1')).toBe(true);
    expect(isNonEmptyString('3.14')).toBe(true);
  });

  it('should handle boolean strings', () => {
    expect(isNonEmptyString('true')).toBe(true);
    expect(isNonEmptyString('false')).toBe(true);
  });

  it('should handle strings with only special characters', () => {
    expect(isNonEmptyString('!@#$%^&*()')).toBe(true);
    expect(isNonEmptyString('...')).toBe(true);
    expect(isNonEmptyString('---')).toBe(true);
  });

  it('should work in conditional chains for type narrowing', () => {
    const value: string | number = 'test';

    if (isNonEmptyString(value)) {
      // TypeScript should know value is string here
      expect(value.toUpperCase()).toBe('TEST');
    }
  });

  it('should handle very long strings', () => {
    const longString = 'a'.repeat(10000);
    expect(isNonEmptyString(longString)).toBe(true);
  });

  it('should handle whitespace mixed with content', () => {
    expect(isNonEmptyString('a b c')).toBe(true);
    expect(isNonEmptyString('  a  b  c  ')).toBe(true);
  });

  it('should work with String object wrappers', () => {
    // eslint-disable-next-line no-new-wrappers
    const strObj = new String('test');
    // String objects are objects, not primitive strings
    expect(isNonEmptyString(strObj)).toBe(false);
  });

  it('should filter empty and whitespace from practical example', () => {
    // Real-world example: filtering user input
    const userInputs = ['Alice', '', '  ', 'Bob', '\t\t', '  Charlie  ', '\n', 'Diana'];

    const validNames = userInputs.filter(isNonEmptyString);

    // Note: '  Charlie  ' is kept because it has content
    expect(validNames).toEqual(['Alice', 'Bob', '  Charlie  ', 'Diana']);
  });
});

// ============================================================================
// Integration Tests - Using Both Functions Together
// ============================================================================

describe('isDefined and isNonEmptyString integration', () => {
  it('should work together to filter valid strings from mixed input', () => {
    const input: Array<string | null | undefined> = [
      'valid',
      null,
      '',
      'another',
      undefined,
      '  ',
      'last',
    ];

    // First filter out null/undefined, then filter out empty strings
    const result = input.filter(isDefined).filter(isNonEmptyString);

    expect(result).toEqual(['valid', 'another', 'last']);
  });

  it('should handle array of optional strings with empty values', () => {
    const names: Array<string | null | undefined> = [
      'Alice',
      null,
      '',
      'Bob',
      undefined,
      '   ',
      'Charlie',
    ];

    const validNames = names.filter(isDefined).filter(isNonEmptyString);

    expect(validNames).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('should work in chained functional pipeline', () => {
    const data = [
      { name: 'Alice', email: 'alice@example.com' },
      { name: null, email: 'no-name@example.com' },
      { name: '', email: 'empty@example.com' },
      { name: '  ', email: 'whitespace@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ];

    const validNames = data
      .map((d) => d.name)
      .filter(isDefined)
      .filter(isNonEmptyString);

    expect(validNames).toEqual(['Alice', 'Bob']);
  });

  it('should handle complex real-world filtering scenario', () => {
    // Example: extracting valid IDs from mixed data
    const possibleIds: Array<string | number | null | undefined> = [
      'id-123',
      null,
      '',
      'id-456',
      123, // number
      undefined,
      '  ',
      'id-789',
    ];

    // Extract only valid string IDs
    const validStringIds = possibleIds.filter(isDefined).filter(isNonEmptyString);

    expect(validStringIds).toEqual(['id-123', 'id-456', 'id-789']);
  });

  it('should demonstrate type narrowing with both guards', () => {
    const value: string | null | undefined = 'test';

    if (isDefined(value) && isNonEmptyString(value)) {
      // TypeScript knows value is a non-empty string here
      expect(value.length).toBeGreaterThan(0);
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });
});
