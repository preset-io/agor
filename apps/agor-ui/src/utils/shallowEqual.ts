/**
 * Shallow-equal helpers for filtering socket-driven re-renders.
 *
 * Feathers re-emits a fresh entity object on every `created` / `patched`
 * event — JSON.parse on the server side guarantees a new reference even
 * when the row is content-identical. Without a content check, the central
 * store handlers in useAgorData would replace the existing entry on every
 * "ghost" patch and cascade an unnecessary re-render through every consumer
 * of `useAppLiveData()` / `useAppRepoData()` etc.
 *
 * These helpers compare top-level keys only. Nested objects that the daemon
 * always reserializes (e.g. `session.model_config`, `branch.git_state`) will
 * read as "different" even when content-equal — that's the safe failure
 * mode: a false negative just means we keep the existing pass-through
 * behavior, no correctness risk.
 */

/**
 * Shallow-equal two plain objects. Returns true iff both have the same
 * key set (own enumerable keys) and every top-level key holds a referentially
 * equal value.
 *
 * - `null` / `undefined` are never equal to a populated object.
 * - Arrays compare by reference (use a dedicated array helper if you need
 *   element-by-element checks).
 * - Nested objects compare by reference — see file docstring above.
 * - Same length but different keys (e.g. `{a: undefined}` vs `{b: undefined}`)
 *   is correctly false because we verify `b` owns each key from `a`.
 */
export function shallowEqualEntity<T extends object>(
  a: T | null | undefined,
  b: T | null | undefined
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;

  const keysA = Object.keys(a) as Array<keyof T>;
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) return false;
    if (!Object.is(a[key], b[key as keyof T])) return false;
  }
  return true;
}
