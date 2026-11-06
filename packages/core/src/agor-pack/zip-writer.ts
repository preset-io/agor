/**
 * Streaming `.agor` writer over `yazl`. Entries are hashed while they are
 * written; `finish` appends `manifest.json` (the entry list plus the canonical
 * content hash) as the last entry, so nothing is buffered beyond one entry.
 *
 * Pipe `output` somewhere before awaiting `addStream`: entries are written in
 * order and each `addStream` resolves only after its bytes reached the zip.
 */

import { createHash } from 'node:crypto';
import { PassThrough, type Readable, Transform } from 'node:stream';
import { ZipFile } from 'yazl';
import { AGOR_PACK, type AgorPackEntry, type AgorPackManifest } from '../types/agor-pack';
import { AgorPackFormatError, assertAgorPackEntryPath } from './paths';

/** Teammate key used inside executor-produced pack fragments. */
export const AGOR_PACK_FRAGMENT_KEY = 't00';

/** Fixed mtime keeps two exports of identical content byte-comparable. */
const ENTRY_MTIME = new Date('2020-01-01T00:00:00Z');

export function computePackContentSha256(entries: readonly AgorPackEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface AgorPackWriteOptions {
  /** POSIX permission bits (0o644 / 0o755). */
  mode?: number;
  /** Store already-compressed or binary payloads without deflate. */
  compress?: boolean;
}

export class AgorPackWriter {
  private readonly zip = new ZipFile();
  private readonly entries: AgorPackEntry[] = [];
  private readonly paths = new Set<string>();
  private totalBytes = 0;
  private finished = false;
  readonly output: Readable;

  constructor() {
    this.output = this.zip.outputStream as unknown as Readable;
  }

  get entryCount(): number {
    return this.entries.length;
  }

  has(path: string): boolean {
    return this.paths.has(path);
  }

  private reserve(path: string): void {
    if (this.finished) throw new AgorPackFormatError('Pack is already finished');
    if (path === AGOR_PACK.manifestPath) {
      throw new AgorPackFormatError('manifest.json is written by finish()');
    }
    assertAgorPackEntryPath(path);
    if (this.paths.has(path)) throw new AgorPackFormatError(`Duplicate pack entry: ${path}`);
    if (this.entries.length + 1 >= AGOR_PACK.maxEntries) {
      throw new AgorPackFormatError(`Pack exceeds ${AGOR_PACK.maxEntries} entries`);
    }
    this.paths.add(path);
  }

  private account(path: string, bytes: number): void {
    if (bytes > AGOR_PACK.maxEntryBytes) {
      throw new AgorPackFormatError(`Pack entry ${path} exceeds ${AGOR_PACK.maxEntryBytes} bytes`);
    }
    this.totalBytes += bytes;
    if (this.totalBytes > AGOR_PACK.maxUncompressedBytes) {
      throw new AgorPackFormatError('Pack exceeds the maximum uncompressed size');
    }
  }

  addBuffer(path: string, data: Buffer | string, options: AgorPackWriteOptions = {}): void {
    this.reserve(path);
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.account(path, buffer.byteLength);
    this.entries.push({
      path,
      bytes: buffer.byteLength,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    });
    this.zip.addBuffer(buffer, path, {
      mtime: ENTRY_MTIME,
      mode: options.mode ?? 0o644,
      compress: options.compress ?? true,
    });
  }

  addJson(path: string, value: unknown): void {
    this.addBuffer(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Resolves once the stream has been fully written into the zip. */
  async addStream(
    path: string,
    stream: Readable,
    options: AgorPackWriteOptions = {}
  ): Promise<void> {
    this.reserve(path);
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.byteLength;
        if (bytes > AGOR_PACK.maxEntryBytes) {
          callback(
            new AgorPackFormatError(`Pack entry ${path} exceeds ${AGOR_PACK.maxEntryBytes} bytes`)
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const done = new Promise<void>((resolve, reject) => {
      meter.once('end', resolve);
      meter.once('error', reject);
      stream.once('error', reject);
    });
    const body = new PassThrough();
    stream.pipe(meter).pipe(body);
    this.zip.addReadStream(body, path, {
      mtime: ENTRY_MTIME,
      mode: options.mode ?? 0o644,
      compress: options.compress ?? true,
    });
    await done;
    this.account(path, bytes);
    this.entries.push({ path, bytes, sha256: hash.digest('hex') });
  }

  /**
   * Write the manifest (built from the final entry list) and close the zip.
   * `build` receives the entries and content hash and returns the manifest.
   */
  finish(
    build: (input: { entries: AgorPackEntry[]; content_sha256: string }) => AgorPackManifest
  ): AgorPackManifest {
    const entries = [...this.entries].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );
    const manifest = build({ entries, content_sha256: computePackContentSha256(entries) });
    this.finished = true;
    this.zip.addBuffer(
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      AGOR_PACK.manifestPath,
      { mtime: ENTRY_MTIME, mode: 0o644 }
    );
    this.zip.end();
    return manifest;
  }

  /**
   * Close a manifest-less fragment (the executor's git/Claude-home slice of
   * one teammate, keyed {@link AGOR_PACK_FRAGMENT_KEY}); the daemon re-keys
   * its entries into the real pack.
   */
  finishFragment(): void {
    this.finished = true;
    this.zip.end();
  }

  /** Abort: destroy the output so a consumer sees a truncated (invalid) zip. */
  abort(error: Error): void {
    this.finished = true;
    this.output.destroy(error);
  }
}
