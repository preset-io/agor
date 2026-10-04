/**
 * Bounded newest-first reader for Codex rollout JSONL files.
 *
 * Rollout logs grow with the whole conversation history, so reading one into
 * memory to find the latest `token_count` record costs a history-sized
 * allocation (plus a second copy from splitting it into lines) on every turn
 * that needs the fallback. This reader walks the file backwards in fixed-size
 * chunks and stops at the newest line whose projection yields a value, so
 * memory is bounded by `maxLineBytes` + `chunkBytes` regardless of file size.
 *
 * For any file that fits within the limits, the result is the same as parsing
 * every line oldest-first and keeping the last non-undefined projection:
 * - lines are split on LF only (a CR before it is JSON whitespace),
 * - bytes are decoded as UTF-8 only once a whole line is assembled, so
 *   multi-byte characters split across chunk boundaries decode correctly,
 * - lines that lack `marker`, fail to parse, or project to undefined are skipped.
 *
 * Bounded deviations:
 * - lines longer than `maxLineBytes` are skipped without being buffered and
 *   the scan continues, so if the newest usable record were oversized an
 *   OLDER record would be returned instead. Genuine `token_count` records are
 *   a few hundred bytes, so this does not occur for real rollout files,
 * - nothing older than the last `maxScanBytes` of the file is examined; when
 *   that budget runs out without a usable record the result is undefined,
 * - if the file shrinks while it is being read, the read is abandoned
 *   (undefined) rather than joining non-contiguous bytes. Bytes appended after
 *   the initial size snapshot are ignored.
 */
import { type FileHandle, open } from 'node:fs/promises';

export interface RolloutTailLimits {
  /** Bytes per backwards read. */
  chunkBytes: number;
  /** Lines longer than this are skipped without being buffered. */
  maxLineBytes: number;
  /** Total bytes examined from the end of the file before giving up. */
  maxScanBytes: number;
}

export const DEFAULT_ROLLOUT_TAIL_LIMITS: Readonly<RolloutTailLimits> = {
  chunkBytes: 64 * 1024,
  maxLineBytes: 1024 * 1024,
  maxScanBytes: 16 * 1024 * 1024,
};

const LF = 0x0a;

export async function findLatestRolloutRecord<T>(
  filePath: string,
  marker: string,
  project: (record: unknown) => T | undefined,
  limits: Readonly<RolloutTailLimits> = DEFAULT_ROLLOUT_TAIL_LIMITS
): Promise<T | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return undefined;
  }

  try {
    const size = (await handle.stat()).size;
    const floor = Math.max(0, size - limits.maxScanBytes);
    const chunk = Buffer.alloc(Math.min(limits.chunkBytes, size - floor));

    // Pieces of the line currently being assembled, newest (rightmost) first.
    let pieces: Buffer[] = [];
    let lineBytes = 0;
    let oversized = false;

    const take = (bytes: Buffer, copy: boolean) => {
      if (oversized) return;
      lineBytes += bytes.length;
      if (lineBytes > limits.maxLineBytes) {
        // Skip this line and keep scanning older ones (see header).
        oversized = true;
        pieces = [];
        return;
      }
      // `chunk` is reused by the next read, so pieces that outlive it are copied.
      if (bytes.length > 0) pieces.push(copy ? Buffer.from(bytes) : bytes);
    };

    const finishLine = (): T | undefined => {
      const line =
        oversized || lineBytes === 0
          ? undefined
          : pieces.length === 1
            ? pieces[0]
            : Buffer.concat(pieces.reverse(), lineBytes);
      pieces = [];
      lineBytes = 0;
      oversized = false;
      if (!line?.includes(marker)) return undefined;
      try {
        return project(JSON.parse(line.toString('utf8')));
      } catch {
        // Ignore malformed / partially-written JSONL lines.
        return undefined;
      }
    };

    let position = size;
    while (position > floor) {
      const length = Math.min(chunk.length, position - floor);
      position -= length;
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      // The file shrank under us; never join non-contiguous bytes.
      if (bytesRead !== length) return undefined;

      const view = chunk.subarray(0, length);
      let end = length;
      while (end > 0) {
        const newline = view.lastIndexOf(LF, end - 1);
        if (newline === -1) break;
        take(view.subarray(newline + 1, end), false);
        const found = finishLine();
        if (found !== undefined) return found;
        end = newline;
      }
      take(view.subarray(0, end), true);
    }

    // Only the first line of the file is known to be complete here; a line cut
    // by the scan budget is not.
    return position === 0 ? finishLine() : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}
