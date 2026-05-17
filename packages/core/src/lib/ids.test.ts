import { describe, expect, it, vi } from 'vitest';
import { prefixToLikePattern, SHORT_ID_LENGTH, toShortId } from '../types/id';
import {
  expandPrefix,
  findByShortIdPrefix,
  findMinimumPrefixLength,
  formatIdForDisplay,
  generateId,
  IdResolutionError,
  isUniquePrefix,
  isValidShortID,
  isValidUUID,
  resolveShortId,
  shortId,
  type UUID,
} from './ids';

describe('generateId', () => {
  it('should generate valid UUIDv7', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('should generate unique IDs', () => {
    const ids = [generateId(), generateId(), generateId()];
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });

  it('should generate chronologically sortable IDs at millisecond resolution', () => {
    // Sleep between generations to guarantee different ms timestamps.
    // Within a single ms our `generateId` randomizes rand_a (to make short
    // IDs collision-safe), so sub-ms sort order is deliberately not
    // guaranteed — only the ms timestamp prefix is.
    const id1 = generateId();
    const t1 = Date.now();
    while (Date.now() === t1) {
      /* spin until next ms */
    }
    const id2 = generateId();
    const t2 = Date.now();
    while (Date.now() === t2) {
      /* spin */
    }
    const id3 = generateId();
    const ids = [id1, id2, id3];
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

describe('isValidUUID', () => {
  it('should accept valid UUIDv7', () => {
    const id = generateId();
    expect(isValidUUID(id)).toBe(true);
  });

  it('should accept lowercase UUIDs', () => {
    expect(isValidUUID('01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f')).toBe(true);
  });

  it('should accept uppercase UUIDs', () => {
    expect(isValidUUID('01933E4A-7B89-7C35-A8F3-9D2E1C4B5A6F')).toBe(true);
  });

  it('should reject invalid formats', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
    expect(isValidUUID('01933e4a')).toBe(false);
    expect(isValidUUID('')).toBe(false);
    expect(isValidUUID('01933e4a-7b89-7c35-a8f3')).toBe(false); // too short
  });

  it('should reject non-v7 UUIDs', () => {
    expect(isValidUUID('01933e4a-7b89-4c35-a8f3-9d2e1c4b5a6f')).toBe(false); // v4
    expect(isValidUUID('01933e4a-7b89-1c35-a8f3-9d2e1c4b5a6f')).toBe(false); // v1
  });
});

describe('isValidShortID', () => {
  it('should accept 8-char hex', () => {
    expect(isValidShortID('01933e4a')).toBe(true);
  });

  it('should accept 12-char hex', () => {
    expect(isValidShortID('01933e4a7b89')).toBe(true);
  });

  it('should accept up to 32-char hex', () => {
    expect(isValidShortID('01933e4a7b897c35a8f39d2e1c4b5a6f')).toBe(true);
  });

  it('should reject non-hex characters', () => {
    expect(isValidShortID('xyz12345')).toBe(false);
    expect(isValidShortID('01933e4g')).toBe(false);
  });

  it('should reject too short', () => {
    expect(isValidShortID('0193')).toBe(false);
    expect(isValidShortID('abc')).toBe(false);
  });

  it('should reject with hyphens', () => {
    expect(isValidShortID('01933e4a-7b89')).toBe(false);
  });
});

describe('shortId', () => {
  const uuid = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID;

  it('returns the canonical SHORT_ID_LENGTH (24-char) prefix', () => {
    expect(shortId(uuid)).toBe('01933e4a7b897c35a8f39d2e');
    expect(shortId(uuid)).toHaveLength(SHORT_ID_LENGTH);
  });

  it('strips hyphens', () => {
    expect(shortId(uuid)).not.toContain('-');
  });

  it('is deterministic for the same input', () => {
    expect(shortId(uuid)).toBe(shortId(uuid));
  });

  it('takes no length parameter — every site agrees on one shape', () => {
    // The whole point of this helper. If a length knob existed, sites would
    // pick their own and we'd re-introduce the same-ms collision bug. The
    // lower-level `toShortId` is available for the rare case that needs a
    // documented non-canonical length.
    expect(toShortId(uuid, 12)).toBe('01933e4a7b89');
  });

  it('does NOT collide for IDs generated in the same millisecond', () => {
    // Freeze the clock so every ID lands in the exact same ms — this is the
    // scenario the helper exists to handle (parent fan-out spawning, MCP
    // tools firing in rapid succession). The library's monotonic-counter
    // UUIDv7 default would collapse 2000 IDs into a handful of unique
    // 24-char prefixes; our `generateId()` passes fresh random bytes per
    // call (RFC 9562 method 3) so every prefix is unique.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const ids = Array.from({ length: 2000 }, () => generateId());
      // Confirm the test fixture actually pins the same ms — first 12 hex
      // chars of UUIDv7 are the timestamp.
      const tsPrefix = ids[0].replace(/-/g, '').slice(0, 12);
      expect(ids.every((id) => id.replace(/-/g, '').startsWith(tsPrefix))).toBe(true);
      const shorts = new Set(ids.map((id) => shortId(id)));
      expect(shorts.size).toBe(ids.length);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatIdForDisplay', () => {
  const uuid = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID;

  it('should return canonical short ID by default', () => {
    expect(formatIdForDisplay(uuid)).toBe('01933e4a7b897c35a8f39d2e');
  });

  it('should return full UUID when verbose', () => {
    expect(formatIdForDisplay(uuid, { verbose: true })).toBe(uuid);
  });
});

describe('expandPrefix', () => {
  it('should expand short prefix', () => {
    expect(expandPrefix('01933e4a')).toBe('01933e4a%');
  });

  it('should add hyphens at UUID positions', () => {
    expect(expandPrefix('01933e4a7b89')).toBe('01933e4a-7b89%');
    expect(expandPrefix('01933e4a7b897c35')).toBe('01933e4a-7b89-7c35%');
  });

  it('should handle full UUID', () => {
    expect(expandPrefix('01933e4a7b897c35a8f39d2e1c4b5a6f')).toBe(
      '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f'
    );
  });

  it('should preserve existing hyphens', () => {
    expect(expandPrefix('01933e4a-7b89')).toBe('01933e4a-7b89%');
  });

  it('should handle partial sections', () => {
    expect(expandPrefix('01933e4a7')).toBe('01933e4a-7%');
    expect(expandPrefix('01933e4a7b8')).toBe('01933e4a-7b8%');
  });

  it('should throw on empty prefix', () => {
    expect(() => expandPrefix('')).toThrow('cannot be empty');
  });

  it('should throw on invalid hex', () => {
    expect(() => expandPrefix('xyz123')).toThrow('Invalid ID prefix');
    expect(() => expandPrefix('gggggggg')).toThrow('must be hexadecimal');
  });
});

describe('resolveShortId', () => {
  const entities = [
    { id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID, name: 'Entity A' },
    { id: '01933e4b-1234-7c35-a8f3-9d2e1c4b5a6f' as UUID, name: 'Entity B' },
    { id: '01934c2d-5678-7c35-a8f3-9d2e1c4b5a6f' as UUID, name: 'Entity C' },
  ];

  it('should resolve unique prefix', () => {
    const result = resolveShortId('01933e4a', entities);
    expect(result.id).toBe(entities[0].id);
  });

  it('should handle prefix with hyphens', () => {
    const result = resolveShortId('01933e4a-7b89', entities);
    expect(result.id).toBe(entities[0].id);
  });

  it('should be case-insensitive', () => {
    const result = resolveShortId('01933E4A', entities);
    expect(result.id).toBe(entities[0].id);
  });

  it('should throw on ambiguous prefix', () => {
    expect(() => resolveShortId('01933e4', entities)).toThrow(IdResolutionError);

    try {
      resolveShortId('01933e4', entities);
    } catch (err) {
      expect(err).toBeInstanceOf(IdResolutionError);
      expect((err as IdResolutionError).type).toBe('ambiguous');
      expect((err as IdResolutionError).candidates).toHaveLength(2);
    }
  });

  it('should throw on not found', () => {
    expect(() => resolveShortId('99999999', entities)).toThrow(IdResolutionError);

    try {
      resolveShortId('99999999', entities);
    } catch (err) {
      expect(err).toBeInstanceOf(IdResolutionError);
      expect((err as IdResolutionError).type).toBe('not_found');
    }
  });

  it('should limit suggestions to 10 matches', () => {
    const manyEntities = Array.from({ length: 20 }, (_, i) => ({
      id: `0193${i.toString().padStart(4, '0')}-7b89-7c35-a8f3-9d2e1c4b5a6f` as UUID,
      name: `Entity ${i}`,
    }));

    try {
      resolveShortId('0193', manyEntities);
    } catch (err) {
      expect((err as IdResolutionError).candidates).toHaveLength(20);
      expect((err as IdResolutionError).message).toContain('and 10 more');
    }
  });
});

describe('findMinimumPrefixLength', () => {
  it('should return 8 for single ID', () => {
    const ids = ['01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID];
    expect(findMinimumPrefixLength(ids)).toBe(8);
  });

  it('should return 8 for empty array', () => {
    expect(findMinimumPrefixLength([])).toBe(8);
  });

  it('should find minimum length for similar IDs', () => {
    const ids = [
      '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID,
      '01933e4b-1234-7c35-a8f3-9d2e1c4b5a6f' as UUID,
    ];
    expect(findMinimumPrefixLength(ids)).toBe(8); // Differ at position 8: '4a' vs '4b'
  });

  it('should handle IDs with longer collisions', () => {
    const ids = [
      '01933e4a7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID,
      '01933e4a7b88-7c35-a8f3-9d2e1c4b5a6f' as UUID,
    ];
    const minLength = findMinimumPrefixLength(ids);
    expect(minLength).toBeGreaterThan(8);
  });
});

describe('findByShortIdPrefix', () => {
  const entities = [
    { id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID, name: 'A' },
    { id: '01933e4b-1234-7c35-a8f3-9d2e1c4b5a6f' as UUID, name: 'B' },
    { id: '01934c2d-5678-7c35-a8f3-9d2e1c4b5a6f' as UUID, name: 'C' },
  ];

  it('returns [] for empty prefix', () => {
    expect(findByShortIdPrefix('', entities)).toEqual([]);
  });

  it('returns [] for non-hex prefix', () => {
    expect(findByShortIdPrefix('xyz12345', entities)).toEqual([]);
    expect(findByShortIdPrefix('gggggggg', entities)).toEqual([]);
  });

  it('returns [] when prefix is only hyphens', () => {
    expect(findByShortIdPrefix('----', entities)).toEqual([]);
  });

  it('returns [] when no entity matches', () => {
    expect(findByShortIdPrefix('99999999', entities)).toEqual([]);
  });

  it('returns all entities sharing a short prefix (timestamp bucket collision)', () => {
    const matches = findByShortIdPrefix('01933e4', entities);
    expect(matches).toHaveLength(2);
    expect(matches.map((e) => e.name).sort()).toEqual(['A', 'B']);
  });

  it('returns the single entity for a unique prefix', () => {
    const matches = findByShortIdPrefix('01933e4a', entities);
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe('A');
  });

  it('matches the full UUID against itself', () => {
    const matches = findByShortIdPrefix(entities[0].id, entities);
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe('A');
  });

  it('strips hyphens from both prefix and entity IDs', () => {
    const matches = findByShortIdPrefix('01933e4a-7b89', entities);
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe('A');
  });

  it('is case-insensitive', () => {
    expect(findByShortIdPrefix('01933E4A', entities)).toHaveLength(1);
    expect(findByShortIdPrefix('01933E4A-7B89', entities)).toHaveLength(1);
  });

  it('is forward-only: prefix longer than ID yields no match', () => {
    // 33+ hex chars cannot be a prefix of a 32-char UUID
    const tooLong = `${entities[0].id.replace(/-/g, '')}ff`;
    expect(findByShortIdPrefix(tooLong, entities)).toEqual([]);
  });

  it('does not match on suffix or substring', () => {
    // Last 8 chars of entity A should not match
    const suffix = entities[0].id.replace(/-/g, '').slice(-8);
    expect(findByShortIdPrefix(suffix, entities)).toEqual([]);
  });

  it('accepts any Iterable of { id } shaped items', () => {
    const iter = new Set(entities);
    const matches = findByShortIdPrefix('0193', iter);
    expect(matches).toHaveLength(3);
  });
});

describe('prefixToLikePattern', () => {
  // The whole point: stored IDs are hyphenated UUIDs, so the LIKE pattern
  // must match that format. A bare-hex prefix that spans a hyphen
  // boundary used to silently match nothing.
  it('passes through a sub-8 prefix unchanged (no hyphen yet)', () => {
    expect(prefixToLikePattern('019e0eca')).toBe('019e0eca%');
    expect(prefixToLikePattern('019')).toBe('019%');
  });

  it('inserts a hyphen at position 8 for prefixes that cross it', () => {
    expect(prefixToLikePattern('019e0eca0d2d')).toBe('019e0eca-0d2d%');
    expect(prefixToLikePattern('019e0eca0d')).toBe('019e0eca-0d%');
  });

  it('inserts hyphens at the canonical positions 8, 12, 16, 20', () => {
    expect(prefixToLikePattern('019e0eca0d2d7000')).toBe('019e0eca-0d2d-7000%');
    expect(prefixToLikePattern('019e0eca0d2d70008000')).toBe('019e0eca-0d2d-7000-8000%');
    expect(prefixToLikePattern('019e0eca0d2d7000800000000000')).toBe(
      '019e0eca-0d2d-7000-8000-00000000%'
    );
  });

  it('accepts already-hyphenated prefixes and re-emits canonical form', () => {
    expect(prefixToLikePattern('019e0eca-0d2d')).toBe('019e0eca-0d2d%');
    // Even malformed-but-equivalent hyphen placement normalizes correctly.
    expect(prefixToLikePattern('019e0-eca0d2d')).toBe('019e0eca-0d2d%');
  });

  it('lowercases the prefix', () => {
    expect(prefixToLikePattern('019E0ECA-0D2D')).toBe('019e0eca-0d2d%');
  });

  it('handles the full 32/36-char canonical UUID', () => {
    expect(prefixToLikePattern('019e0eca0d2d7000800000000000abcd')).toBe(
      '019e0eca-0d2d-7000-8000-00000000abcd%'
    );
    expect(prefixToLikePattern('019e0eca-0d2d-7000-8000-00000000abcd')).toBe(
      '019e0eca-0d2d-7000-8000-00000000abcd%'
    );
  });
});

describe('isUniquePrefix', () => {
  const entities = [
    { id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID, name: 'A' },
    { id: '01933e4b-1234-7c35-a8f3-9d2e1c4b5a6f' as UUID, name: 'B' },
  ];

  it('should return true for unique prefix', () => {
    expect(isUniquePrefix('01933e4a', entities)).toBe(true);
  });

  it('should return false for ambiguous prefix', () => {
    expect(isUniquePrefix('0193', entities)).toBe(false);
  });

  it('should return false for not found', () => {
    expect(isUniquePrefix('99999999', entities)).toBe(false);
  });
});
