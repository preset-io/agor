/** Join concurrent work for the same key and forget it once it settles. */
export function runKeyedSingleFlight<Key, Result>(
  inFlight: Map<Key, Promise<Result>>,
  key: Key,
  work: () => Promise<Result>
): Promise<Result> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = work().finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}
