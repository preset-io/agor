import { type ArtifactRepository, attachHiddenTenant } from '@agor/core/db';
import type { Board, HookContext } from '@agor/core/types';

/** Filter only artifact references; board authorization and tenant scope are upstream. */
export function filterBoardArtifactObjects(
  artifacts: Pick<ArtifactRepository, 'findBoardReferenceVisibleIds'>
) {
  return async (context: HookContext<Board>) => {
    const result = context.result;
    if (!result) return context;
    const boards: Board[] =
      context.method === 'get'
        ? [result]
        : Array.isArray(result)
          ? result
          : (result as unknown as { data: Board[] }).data;
    if (!boards?.length) return context;

    const references = new Set<string>();
    for (const board of boards) {
      for (const object of Object.values(board.objects ?? {})) {
        if (
          object?.type === 'artifact' &&
          typeof object.artifact_id === 'string' &&
          object.artifact_id
        ) {
          references.add(object.artifact_id);
        }
      }
    }
    const userId = (context.params as { user?: { user_id: string } }).user?.user_id;
    let visible = new Set<string>();
    if (references.size) {
      try {
        visible = await artifacts.findBoardReferenceVisibleIds([...references], userId);
      } catch {
        // Ordinary query failures are denied per bounded repository chunk,
        // retaining other verified successes. A boundary/unexpected failure
        // here denies all references; it must never expose private/stale data.
      }
    }
    for (const board of boards) {
      if (!board.objects) continue;
      let filtered: Board['objects'];
      for (const [key, object] of Object.entries(board.objects)) {
        // Preserve legacy placeholders with no artifact_id, and all non-artifact
        // objects. Do not rewrite keys, positions, or other board metadata.
        if (object?.type === 'artifact' && object.artifact_id && !visible.has(object.artifact_id)) {
          filtered ??= { ...board.objects };
          delete filtered[key];
        }
      }
      // No-op reads preserve identity and nonenumerable metadata. Changed get
      // responses retain the trusted tenant marker for downstream assertions.
      if (!filtered) continue;
      if (context.method === 'get') {
        context.result = attachHiddenTenant({ ...board, objects: filtered }, board);
      } else board.objects = filtered;
    }
    return context;
  };
}
