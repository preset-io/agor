import { describe, expect, it } from 'vitest';
import { parseGitStateSha } from './gitState';

describe('parseGitStateSha', () => {
  it('returns empty + clean for null/undefined/empty', () => {
    expect(parseGitStateSha(null)).toEqual({ cleanSha: '', isDirty: false });
    expect(parseGitStateSha(undefined)).toEqual({ cleanSha: '', isDirty: false });
    expect(parseGitStateSha('')).toEqual({ cleanSha: '', isDirty: false });
  });

  it('returns clean SHA unchanged', () => {
    expect(parseGitStateSha('abc123def456')).toEqual({
      cleanSha: 'abc123def456',
      isDirty: false,
    });
  });

  it('strips the -dirty suffix when present', () => {
    expect(parseGitStateSha('abc123def456-dirty')).toEqual({
      cleanSha: 'abc123def456',
      isDirty: true,
    });
  });

  it('only strips suffix, not arbitrary occurrences', () => {
    // Pathological SHA-like input where "-dirty" appears mid-string.
    // String.replace would have eaten it; we should leave it alone.
    expect(parseGitStateSha('abc-dirty-def')).toEqual({
      cleanSha: 'abc-dirty-def',
      isDirty: false,
    });
  });

  it('passes through the sentinel "unknown" value', () => {
    expect(parseGitStateSha('unknown')).toEqual({ cleanSha: 'unknown', isDirty: false });
  });
});
