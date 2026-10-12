/**
 * Minimal `custom_context` patch for a session settings edit.
 *
 * Session patches deep-merge `custom_context` on the daemon (objects merge,
 * arrays and primitives replace, `undefined` is skipped). Sending the whole
 * edited JSON would echo every untouched value from the snapshot the editor
 * was seeded with, reverting anything that changed since — e.g. SDK-reported
 * `slash_commands` updated to `['/new']` would go back to `['/old']` when the
 * user only edited `teamName`.
 *
 * So the patch carries only top-level keys whose value differs structurally
 * from the snapshot. A key the user deleted is sent as `null` (deep merge
 * cannot delete; `null` is the explicit clear). A changed top-level object is
 * sent whole and merged by the daemon.
 */

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural equality for JSON values (object key order is irrelevant). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * Patch for `custom_context`, or `undefined` when nothing changed. A
 * non-object edit (not a valid context) is passed through for the daemon to
 * validate, as before.
 */
export function buildCustomContextPatch(
  snapshot: unknown,
  edited: unknown
): Record<string, unknown> | undefined {
  if (!isPlainObject(edited)) return edited as Record<string, unknown> | undefined;
  const base = isPlainObject(snapshot) ? snapshot : {};
  const patch: JsonObject = {};
  for (const [key, value] of Object.entries(edited)) {
    if (!jsonEqual(value, base[key])) patch[key] = value;
  }
  for (const key of Object.keys(base)) {
    if (!Object.hasOwn(edited, key)) patch[key] = null;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}
