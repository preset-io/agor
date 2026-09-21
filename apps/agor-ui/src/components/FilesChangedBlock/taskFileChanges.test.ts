import type { DiffEnrichment, Message } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { collectFileChanges, hasAggregatedFileChanges } from './taskFileChanges';

const structuredPatch = [
  { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
];
const toolUse = {
  type: 'tool_use' as const,
  id: 'edit-1',
  name: 'edit_files',
  input: {
    changes: [
      { path: 'small.ts', kind: 'update' },
      { path: 'large.txt', kind: 'update' },
    ],
  },
};
const small = { path: '/repo/small.ts', kind: 'update' as const, structuredPatch };

const collect = (diff: DiffEnrichment) =>
  collectFileChanges([
    { content: [toolUse] },
    { content: [{ type: 'tool_result', tool_use_id: toolUse.id, diff }] },
  ] as unknown as Message[]);

describe('file-change aggregation coverage', () => {
  it.each([
    { structuredPatch, files: [small] },
    {
      structuredPatch,
      files: [small, { path: 'large.txt', kind: 'update' as const, structuredPatch: [] }],
    },
    { structuredPatch, files: [] },
  ])('keeps a multi-file call outside aggregation when a path has no patch', (diff) => {
    expect(hasAggregatedFileChanges(toolUse, diff)).toBe(false);
    expect(collect(diff)).toBeNull();
  });

  it('aggregates a fully represented call using the renderer path matching', () => {
    const diff = {
      structuredPatch,
      files: [small, { path: 'C:\\repo\\large.txt', kind: 'update' as const, structuredPatch }],
    };
    expect(hasAggregatedFileChanges(toolUse, diff)).toBe(true);
    expect(collect(diff)).toMatchObject({ fileCount: 2, additions: 2, deletions: 2 });
  });

  it('does not hide a single-file call that the collector cannot name', () => {
    expect(hasAggregatedFileChanges({ name: 'Edit', input: {} }, { structuredPatch })).toBe(false);
  });

  it.each([
    ['missing changes', {}],
    ['undefined changes', { changes: undefined }],
    ['null changes', { changes: null }],
    ['non-array changes', { changes: {} }],
    ['empty changes', { changes: [] }],
    ['null entry', { changes: [null] }],
    ['missing path', { changes: [{}] }],
    ['null path', { changes: [{ path: null }] }],
    ['non-string path', { changes: [{ path: 42 }] }],
    ['empty path', { changes: [{ path: '' }] }],
    ['whitespace-only path', { changes: [{ path: '  ' }] }],
    ['valid and malformed entries', { changes: [{ path: 'small.ts' }, null] }],
  ])('rejects malformed edit_files declarations without throwing (%s)', (_label, input) => {
    expect(() =>
      hasAggregatedFileChanges({ name: 'edit_files', input }, { structuredPatch })
    ).not.toThrow();
    expect(hasAggregatedFileChanges({ name: 'edit_files', input }, { structuredPatch })).toBe(
      false
    );
  });

  it('requires separate patches for paths sharing a suffix', () => {
    const call = {
      name: 'edit_files',
      input: { changes: [{ path: 'small.ts' }, { path: 'src/small.ts' }] },
    };
    const nested = { ...small, path: '/repo/src/small.ts' };
    expect(hasAggregatedFileChanges(call, { structuredPatch, files: [nested] })).toBe(false);
    expect(hasAggregatedFileChanges(call, { structuredPatch, files: [nested, small] })).toBe(true);
  });
});
