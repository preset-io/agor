/** Runs `task` for every item, at most `limit` at once; resolves with the items whose task failed. */
export async function runWithLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<unknown>
): Promise<T[]> {
  const failed: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await task(item);
      } catch {
        failed.push(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return failed;
}
