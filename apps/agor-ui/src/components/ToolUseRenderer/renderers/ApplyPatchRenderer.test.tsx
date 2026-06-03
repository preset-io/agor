import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApplyPatchRenderer, parseApplyPatch } from './ApplyPatchRenderer';

describe('parseApplyPatch', () => {
  it('parses Codex apply_patch updates as remove/add diff lines', () => {
    const files = parseApplyPatch(`*** Begin Patch
*** Update File: src/example.ts
@@
 const unchanged = true;
-const value = "old";
+const value = "new";
*** End Patch
`);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/example.ts');
    expect(files[0].kind).toBe('update');
    expect(files[0].structuredPatch[0].lines).toEqual([
      ' const unchanged = true;',
      '-const value = "old";',
      '+const value = "new";',
    ]);
  });

  it('parses add and delete files', () => {
    const files = parseApplyPatch(`*** Begin Patch
*** Add File: src/added.ts
+export const added = true;
*** Delete File: src/deleted.ts
-export const deleted = true;
*** End Patch
`);

    expect(files).toHaveLength(2);
    expect(files[0].kind).toBe('add');
    expect(files[0].structuredPatch[0].lines).toEqual(['+export const added = true;']);
    expect(files[1].kind).toBe('delete');
    expect(files[1].structuredPatch[0].lines).toEqual(['-export const deleted = true;']);
  });

  it('preserves delete-only file operations with no deleted lines', () => {
    const files = parseApplyPatch(`*** Begin Patch
*** Delete File: src/deleted.ts
*** End Patch
`);

    expect(files).toEqual([
      {
        path: 'src/deleted.ts',
        kind: 'delete',
        moveTo: undefined,
        structuredPatch: [],
      },
    ]);
  });

  it('parses update patches with Move to metadata', () => {
    const files = parseApplyPatch(`*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-export const name = "old";
+export const name = "new";
*** End Patch
`);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/old.ts');
    expect(files[0].moveTo).toBe('src/new.ts');
    expect(files[0].structuredPatch[0].lines).toEqual([
      '-export const name = "old";',
      '+export const name = "new";',
    ]);
  });

  it('preserves move-only file operations', () => {
    const files = parseApplyPatch(`*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
*** End Patch
`);

    expect(files).toEqual([
      {
        path: 'src/old.ts',
        kind: 'update',
        moveTo: 'src/new.ts',
        structuredPatch: [],
      },
    ]);
  });

  it('treats multiple plain @@ and @@ context headers as separate hunks', () => {
    const files = parseApplyPatch(`*** Begin Patch
*** Update File: src/example.ts
@@
-a
+b
@@ function c
-c
+d
*** End Patch
`);

    expect(files[0].structuredPatch).toHaveLength(2);
    expect(files[0].structuredPatch.map((hunk) => hunk.lines)).toEqual([
      ['-a', '+b'],
      ['-c', '+d'],
    ]);
  });

  it('extracts unified-style hunk line numbers', () => {
    const files = parseApplyPatch(`*** Begin Patch
*** Update File: src/example.ts
@@ -10,2 +20,3 @@ function example
 old context
-old
+new
+extra
*** End Patch
`);

    expect(files[0].structuredPatch[0]).toMatchObject({
      oldStart: 10,
      oldLines: 2,
      newStart: 20,
      newLines: 3,
    });
  });
});

describe('ApplyPatchRenderer', () => {
  it('renders raw string input as a diff', () => {
    render(
      <ApplyPatchRenderer
        toolUseId="tool-apply-patch-1"
        input={
          `*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch
` as unknown as Record<string, unknown>
        }
        result={{ content: 'ok' }}
      />
    );

    expect(screen.getByText('Update')).toBeInTheDocument();
    expect(screen.getByText('src/example.ts')).toBeInTheDocument();
    expect(screen.getByText('old')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
  });

  it('renders object patch input and delete-only operations', () => {
    render(
      <ApplyPatchRenderer
        toolUseId="tool-apply-patch-2"
        input={{
          patch: `*** Begin Patch
*** Delete File: src/deleted.ts
*** End Patch
`,
        }}
        result={{ content: 'ok' }}
      />
    );

    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.getByText('src/deleted.ts')).toBeInTheDocument();
  });

  it('renders move-only operations', () => {
    render(
      <ApplyPatchRenderer
        toolUseId="tool-apply-patch-3"
        input={{
          patch: `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
*** End Patch
`,
        }}
        result={{ content: 'ok' }}
      />
    );

    expect(screen.getByText('Move')).toBeInTheDocument();
    expect(screen.getByText('src/old.ts')).toBeInTheDocument();
    expect(screen.getByText('src/new.ts')).toBeInTheDocument();
  });

  it('uses status-sensitive fallback text for malformed patches and failures', () => {
    const { rerender } = render(
      <ApplyPatchRenderer
        toolUseId="tool-apply-patch-4"
        input={{ patch: 'not an apply_patch payload' }}
        result={{ content: 'ok' }}
      />
    );

    expect(screen.getByText('Unable to parse patch')).toBeInTheDocument();

    rerender(
      <ApplyPatchRenderer
        toolUseId="tool-apply-patch-4"
        input={{ patch: 'not an apply_patch payload' }}
        result={{ content: 'bad patch', is_error: true }}
      />
    );

    expect(screen.getByText('Patch failed')).toBeInTheDocument();
    expect(screen.getByText('bad patch')).toBeInTheDocument();
  });
});
