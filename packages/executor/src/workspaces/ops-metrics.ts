/** Process-lifetime counters for trusted fleet operators; no object keys or credentials. */
const startedAt = new Date().toISOString();
const buckets = new Map<string, Record<string, number>>();
export function blobMetric(bucket: string, name: string, value = 1) {
  const counters = buckets.get(bucket) ?? {};
  counters[name] = (counters[name] ?? 0) + value;
  buckets.set(bucket, counters);
}
export function blobMetrics() {
  return { startedAt, buckets: Object.fromEntries([...buckets].map(([k, v]) => [k, { ...v }])) };
}
