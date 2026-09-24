import { open } from 'node:fs/promises';

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Read newest-first with fixed-size reads and at most 1 MiB per JSON record.
 * Oversized records without a token marker are skipped, never read in full.
 * A possible token marker (even quoted in unrelated output) yields unknown:
 * bounded scanning cannot validate it, and an older value must not look latest.
 * UTF-8 is decoded only after a whole line is assembled. A concurrent append
 * is outside the initial file-size snapshot; malformed/truncated tails are ignored.
 */
export async function findLatestJsonLine<T>(
  filename: string,
  project: (value: unknown) => T | undefined
): Promise<T | undefined> {
  const file = await open(filename, 'r').catch(() => undefined);
  if (!file) return undefined;
  try {
    let position = (await file.stat()).size;
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let parts: Buffer[] = [];
    let length = 0;
    let oversized = false;
    let tokenMarker = false;
    let rightPrefix = '';
    let uncertain = false;
    const append = (part: Buffer) => {
      // Detect token_count even when its ASCII marker crosses a read boundary.
      const markerText = part.toString('utf8');
      tokenMarker ||= (markerText + rightPrefix).includes('token_count');
      rightPrefix = markerText.slice(0, 16);
      length += part.length;
      if (length > MAX_LINE_BYTES) {
        oversized = true;
        parts = [];
      } else if (!oversized) parts.push(Buffer.from(part));
    };
    const finish = (): T | undefined => {
      try {
        // We cannot validate an oversized possible token record. Returning an
        // older snapshot would risk reporting stale usage as the latest.
        if (oversized && tokenMarker) uncertain = true;
        if (!oversized && length) {
          const line = Buffer.concat(parts.reverse(), length).toString('utf8');
          if (line.includes('token_count')) return project(JSON.parse(line));
        }
      } catch {
        // Malformed JSON or an incomplete final write is not usage evidence.
      } finally {
        parts = [];
        length = 0;
        oversized = false;
        tokenMarker = false;
        rightPrefix = '';
      }
      return undefined;
    };
    while (position > 0) {
      const size = Math.min(position, CHUNK_BYTES);
      position -= size;
      const { bytesRead } = await file.read(chunk, 0, size, position);
      // A truncate invalidates this snapshot; never join noncontiguous bytes.
      if (bytesRead !== size) return undefined;
      let end = size;
      for (let index = size - 1; index >= 0; index--) {
        if (chunk[index] !== 10) continue;
        append(chunk.subarray(index + 1, end));
        const value = finish();
        if (uncertain) return undefined;
        if (value !== undefined) return value;
        end = index;
      }
      append(chunk.subarray(0, end));
    }
    const value = finish();
    return uncertain ? undefined : value;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}
