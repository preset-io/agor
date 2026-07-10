/**
 * Memoized timestamp parsing for immutable store entities.
 *
 * Sessions, branches and boards are replaced by a fresh object on every patch,
 * never mutated in place. That makes them safe WeakMap keys: a parsed epoch
 * stays valid for the lifetime of the object, and the entry is collected when
 * the object is replaced. The home page re-derives its feeds on every store
 * notify (one per streamed token on busy instances), so parsing the same
 * `new Date(entity.field)` on every comparison and every scan dominated the
 * frame. Here each (entity, field) is parsed once and reused thereafter.
 */

const cache = new WeakMap<object, Record<string, number>>();

/**
 * Epoch milliseconds for `entity[field]`, parsed at most once per object.
 * Returns `NaN` for a missing/invalid value (same as `new Date(x).getTime()`),
 * and caches that result too so repeat lookups stay allocation-free.
 */
export function getTimeMs(entity: object | null | undefined, field: string): number {
  if (!entity) return Number.NaN;
  let fields = cache.get(entity);
  if (!fields) {
    fields = {};
    cache.set(entity, fields);
  }
  const cached = fields[field];
  if (cached !== undefined) return cached;
  const raw = (entity as Record<string, unknown>)[field];
  const value = raw ? new Date(raw as string | number | Date).getTime() : Number.NaN;
  fields[field] = value;
  return value;
}
