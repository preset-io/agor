import { describe, expect, it } from 'vitest';
import {
  JSON_SANITIZER_LIMITS,
  JsonSanitizationError,
  sanitizeJsonValue,
  sanitizeUnicodeString,
} from './sanitize-json';

describe('JSON persistence sanitizer', () => {
  it('replaces NUL and lone surrogates while preserving valid Unicode exactly', () => {
    const normal = 'emoji 😀 e\u0301 العربية\nline';
    expect(sanitizeUnicodeString(`a\0b\ud800c\udc00d`)).toBe('a�b�c�d');
    expect(sanitizeUnicodeString(normal)).toBe(normal);
  });

  it('clones nested arrays and plain objects without mutation', () => {
    const input = { nested: ['ok', { bad: '\0' }] };
    const result = sanitizeJsonValue(input);
    expect(result).toEqual({ nested: ['ok', { bad: '�' }] });
    expect(result).not.toBe(input);
    expect(result.nested).not.toBe(input.nested);
    expect(input.nested[1]).toEqual({ bad: '\0' });
  });

  it('sanitizes object keys and rejects replacement collisions', () => {
    expect(sanitizeJsonValue({ 'bad\0key': 'value' })).toEqual({ 'bad�key': 'value' });
    expect(() => sanitizeJsonValue({ 'bad\0key': 1, 'bad�key': 2 })).toThrow(/key_collision/);
  });

  it('allows repeated references while rejecting actual cycles', () => {
    const shared = { value: '\0' };
    const result = sanitizeJsonValue({ first: shared, second: shared });
    expect(result).toEqual({ first: { value: '�' }, second: { value: '�' } });
    expect(result.first).not.toBe(result.second);
  });

  it('rejects cycles, excessive depth, unsupported values, and excessive strings predictably', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => sanitizeJsonValue(cyclic)).toThrowError(JsonSanitizationError);
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < JSON_SANITIZER_LIMITS.maxDepth + 2; i++) deep = deep.next = {};
    expect(() => sanitizeJsonValue(root)).toThrow(/depth/);
    expect(() => sanitizeJsonValue({ value: BigInt(1) })).toThrow(/unsupported/);
    expect(() =>
      sanitizeJsonValue({ value: 'x'.repeat(JSON_SANITIZER_LIMITS.maxStringCodeUnits + 1) })
    ).toThrow(/size/);
    expect(() =>
      sanitizeJsonValue('x'.repeat(JSON_SANITIZER_LIMITS.maxStringCodeUnits + 1))
    ).toThrow(/size/);
    expect(() =>
      sanitizeJsonValue({ ['x'.repeat(JSON_SANITIZER_LIMITS.maxStringCodeUnits + 1)]: true })
    ).toThrow(/size/);
  });

  it('rejects huge flat arrays and objects at the work budget', () => {
    expect(() => sanitizeJsonValue(new Array(JSON_SANITIZER_LIMITS.maxNodes + 1))).toThrow(/size/);
    const flat: Record<string, number> = {};
    for (let index = 0; index < JSON_SANITIZER_LIMITS.maxNodes; index++) flat[index] = index;
    expect(() => sanitizeJsonValue(flat)).toThrow(/size/);
  });
});
