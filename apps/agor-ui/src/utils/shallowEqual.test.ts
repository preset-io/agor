import { describe, expect, it } from 'vitest';
import { shallowEqualEntity } from './shallowEqual';

describe('shallowEqualEntity', () => {
  it('returns true for identical references', () => {
    const a = { id: '1', name: 'x' };
    expect(shallowEqualEntity(a, a)).toBe(true);
  });

  it('returns true for structurally equal objects with primitive fields', () => {
    expect(shallowEqualEntity({ id: '1', n: 2 }, { id: '1', n: 2 })).toBe(true);
  });

  it('returns false when a top-level primitive differs', () => {
    expect(shallowEqualEntity({ id: '1', n: 2 }, { id: '1', n: 3 })).toBe(false);
  });

  it('returns false when key sets differ', () => {
    expect(
      shallowEqualEntity({ id: '1', n: 2 } as { id: string; n: number }, { id: '1', n: 2, m: 5 })
    ).toBe(false);
  });

  it('returns false when key sets differ but lengths match (both undefined values)', () => {
    // Regression: bag-of-keys check that only compared lengths would say
    // `{a: undefined}` equals `{b: undefined}` because `obj.a` and `obj.b`
    // both read back as `undefined`. The hasOwnProperty check catches this.
    expect(shallowEqualEntity({ a: undefined } as object, { b: undefined } as object)).toBe(false);
  });

  it('treats NaN as equal to NaN (Object.is semantics)', () => {
    expect(shallowEqualEntity({ x: Number.NaN }, { x: Number.NaN })).toBe(true);
  });

  it('returns false when a nested object has a fresh reference', () => {
    // Documents the safe failure mode — fresh JSON-parsed payloads always
    // produce new nested object refs, so shallow-equal won't catch content-
    // identical patches with nested fields. Bailing out is opportunistic.
    expect(shallowEqualEntity({ id: '1', nested: { v: 1 } }, { id: '1', nested: { v: 1 } })).toBe(
      false
    );
  });

  it('returns true when nested object has the same reference', () => {
    const nested = { v: 1 };
    expect(shallowEqualEntity({ id: '1', nested }, { id: '1', nested })).toBe(true);
  });

  it('handles null and undefined inputs', () => {
    expect(shallowEqualEntity(null, null)).toBe(true);
    expect(shallowEqualEntity(undefined, undefined)).toBe(true);
    expect(shallowEqualEntity({ a: 1 }, null)).toBe(false);
    expect(shallowEqualEntity(null, { a: 1 })).toBe(false);
  });
});
