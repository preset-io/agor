import { describe, expect, it } from 'vitest';
import { parseApplyPatch } from './ApplyPatchRenderer';

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
});
