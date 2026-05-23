/**
 * Tests for parseStorageFormValue.
 *
 * Pins the composite-form-value → {storage_mode, clone_depth} translation
 * so the three submit paths (NewWorktreeModal, WorktreeTab, WorktreesTable)
 * stay in lockstep with the daemon's expected request body shape.
 */

import { describe, expect, it } from 'vitest';
import { parseStorageFormValue } from './storage';

describe('parseStorageFormValue', () => {
  it('returns the safe default for the "worktree" choice', () => {
    expect(parseStorageFormValue('worktree')).toEqual({ storage_mode: 'worktree' });
  });

  it('returns clone mode without a depth for the "clone" (full) choice', () => {
    expect(parseStorageFormValue('clone')).toEqual({ storage_mode: 'clone' });
  });

  it('parses the shallow-depth shorthand `clone:<N>` into clone_depth', () => {
    expect(parseStorageFormValue('clone:100')).toEqual({
      storage_mode: 'clone',
      clone_depth: 100,
    });
    expect(parseStorageFormValue('clone:1')).toEqual({
      storage_mode: 'clone',
      clone_depth: 1,
    });
  });

  it('falls back to the safe default for unknown / malformed strings', () => {
    // Pin the fallback so a typo in the Select options can never silently
    // toggle clone-mode on someone's worktree.
    expect(parseStorageFormValue('clone:abc')).toEqual({ storage_mode: 'worktree' });
    expect(parseStorageFormValue('clone:')).toEqual({ storage_mode: 'worktree' });
    expect(parseStorageFormValue('')).toEqual({ storage_mode: 'worktree' });
    expect(parseStorageFormValue('garbage')).toEqual({ storage_mode: 'worktree' });
  });

  it('falls back to the safe default for non-string input', () => {
    expect(parseStorageFormValue(undefined)).toEqual({ storage_mode: 'worktree' });
    expect(parseStorageFormValue(null)).toEqual({ storage_mode: 'worktree' });
    expect(parseStorageFormValue(100)).toEqual({ storage_mode: 'worktree' });
    expect(parseStorageFormValue({})).toEqual({ storage_mode: 'worktree' });
  });
});
