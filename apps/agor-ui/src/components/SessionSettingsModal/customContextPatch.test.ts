import { describe, expect, it } from 'vitest';
// The daemon's real receiver-side merge for session patches (pure TS).
import { deepMerge } from '../../../../../packages/core/src/db/repositories/merge-utils';
import { buildCustomContextPatch, jsonEqual } from './customContextPatch';

const snapshot = {
  teamName: 'Backend',
  slash_commands: ['/old'],
  scheduled_run: { run_index: 3, rendered_prompt: 'p' },
};

/** What the daemon stores: deep-merge the patch into the current context. */
const applied = (current: Record<string, unknown>, patch: Record<string, unknown> | undefined) =>
  patch === undefined
    ? current
    : (deepMerge({ custom_context: current }, { custom_context: patch }).custom_context as Record<
        string,
        unknown
      >);

describe('buildCustomContextPatch', () => {
  it('editing one key keeps a newer concurrent array update', () => {
    const edited = { ...snapshot, teamName: 'Frontend' };
    const patch = buildCustomContextPatch(snapshot, edited);
    expect(patch).toEqual({ teamName: 'Frontend' });

    // The SDK replaced slash_commands while the editor was open.
    const server = { ...snapshot, slash_commands: ['/new'] };
    expect(applied(server, patch)).toEqual({ ...server, teamName: 'Frontend' });
  });

  it('sends nothing when the edit is only formatting or key order', () => {
    const reordered = JSON.parse(
      '{"scheduled_run":{"rendered_prompt":"p","run_index":3},"slash_commands":["/old"],"teamName":"Backend"}'
    );
    expect(buildCustomContextPatch(snapshot, reordered)).toBeUndefined();
  });

  it('sends a changed array or object key, and adds new keys', () => {
    const patch = buildCustomContextPatch(snapshot, {
      ...snapshot,
      slash_commands: ['/mine'],
      scheduled_run: { run_index: 4, rendered_prompt: 'p' },
      sprint: 7,
    });
    expect(patch).toEqual({
      slash_commands: ['/mine'],
      scheduled_run: { run_index: 4, rendered_prompt: 'p' },
      sprint: 7,
    });
    expect(applied(snapshot, patch)).toMatchObject({ slash_commands: ['/mine'], sprint: 7 });
  });

  it('clears a deleted key explicitly (deep merge cannot delete)', () => {
    const { teamName: _removed, ...rest } = snapshot;
    const patch = buildCustomContextPatch(snapshot, rest);
    expect(patch).toEqual({ teamName: null });
    expect(applied(snapshot, patch).teamName).toBeNull();
  });

  it('passes a non-object edit through for daemon validation', () => {
    expect(buildCustomContextPatch(snapshot, ['x'])).toEqual(['x']);
  });
});

describe('jsonEqual', () => {
  it('compares structure, not identity or key order', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: undefined }, {})).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
});
