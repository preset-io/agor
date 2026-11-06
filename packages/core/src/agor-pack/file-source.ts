/** File-backed `.agor` byte source for the CLI and executor (not the daemon). */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import type { AgorPackByteSource } from './zip-reader';

export async function fileByteSource(path: string): Promise<AgorPackByteSource> {
  const info = await stat(path);
  return {
    size: info.size,
    readRange: (start, end) =>
      // createReadStream's `end` is inclusive.
      end <= start ? new PassThrough().end() : createReadStream(path, { start, end: end - 1 }),
  };
}
