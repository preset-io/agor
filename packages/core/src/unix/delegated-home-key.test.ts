import { describe, expect, it } from 'vitest';
import {
  assertExecutionHomeKeySatisfiesMode,
  isValidExecutionHomeKey,
  resolveDelegatedHomeKey,
} from './delegated-home-key.js';

describe('delegated home-key compatibility', () => {
  it.each(['alice', '_service', 'agor_user-1'])('accepts conservative home key %s', (value) =>
    expect(isValidExecutionHomeKey(value)).toBe(true)
  );

  it.each(['', 'Alice', '../alice', 'alice/name', 'alice name', 'a'.repeat(33)])(
    'rejects unsafe home key %s',
    (value) => expect(isValidExecutionHomeKey(value)).toBe(false)
  );

  it('requires a home key only for delegated execution', () => {
    expect(() => assertExecutionHomeKeySatisfiesMode(null, 'simple')).not.toThrow();
    expect(() => assertExecutionHomeKeySatisfiesMode(null, 'sandbox')).not.toThrow();
    expect(() => assertExecutionHomeKeySatisfiesMode(null, 'delegated')).toThrow(/home key/);
    expect(() => assertExecutionHomeKeySatisfiesMode('../alice', 'delegated')).toThrow(
      /invalid format/
    );
  });

  it('never selects a host Unix identity for local execution', () => {
    expect(resolveDelegatedHomeKey({ mode: 'simple', executionHomeKey: 'alice' })).toMatchObject({
      delegatedHomeKey: null,
    });
    expect(resolveDelegatedHomeKey({ mode: 'sandbox', executionHomeKey: 'alice' })).toMatchObject({
      delegatedHomeKey: null,
    });
  });

  it('forwards only a validated delegated home key', () => {
    expect(resolveDelegatedHomeKey({ mode: 'delegated', executionHomeKey: 'alice' })).toMatchObject(
      {
        delegatedHomeKey: 'alice',
      }
    );
    expect(() => resolveDelegatedHomeKey({ mode: 'delegated' })).toThrow(
      /requires a unix_username/
    );
    expect(() =>
      resolveDelegatedHomeKey({ mode: 'delegated', executionHomeKey: '../alice' })
    ).toThrow(/invalid format/);
  });
});
