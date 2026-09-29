import { describe, expect, it } from 'vitest';
import {
  encodeListSyncKnown,
  isListSyncPage,
  isListSyncPath,
  LIST_SYNC_HASH_LENGTH,
  LIST_SYNC_MAX_KNOWN,
  splitListSyncVersions,
} from './list-sync';

const v = (char: string) => char.repeat(LIST_SYNC_HASH_LENGTH);

describe('list-sync protocol helpers', () => {
  it('round-trips versions and drops malformed ones when encoding', () => {
    const known = encodeListSyncKnown([v('a'), 'short', v('B'), `${v('c').slice(1)}!`, v('-')]);
    expect(splitListSyncVersions(known)).toEqual([v('a'), v('B'), v('-')]);
    expect(splitListSyncVersions('')).toEqual([]);
  });

  it('rejects partial, non-alphabet, oversized or non-string input', () => {
    expect(splitListSyncVersions('abc')).toBeNull();
    expect(splitListSyncVersions(`${v('a').slice(1)}.`)).toBeNull();
    expect(splitListSyncVersions(v('a').repeat(LIST_SYNC_MAX_KNOWN + 1))).toBeNull();
    expect(splitListSyncVersions(undefined)).toBeNull();
  });

  it('caps the encoded list', () => {
    const many = Array.from({ length: LIST_SYNC_MAX_KNOWN + 5 }, () => v('z'));
    expect(encodeListSyncKnown(many)).toHaveLength(LIST_SYNC_MAX_KNOWN * LIST_SYNC_HASH_LENGTH);
  });

  it('recognizes versioned paths and pages', () => {
    expect(isListSyncPath('sessions')).toBe(true);
    expect(isListSyncPath('toString')).toBe(false);
    expect(isListSyncPage({ total: 0, limit: 0, skip: 0, data: [], $sync: { versions: '' } })).toBe(
      true
    );
    expect(isListSyncPage({ total: 0, limit: 0, skip: 0, data: [] })).toBe(false);
  });
});
