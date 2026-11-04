/**
 * Random-access `.agorpack` reader over `yauzl`. Opening a pack reads only
 * the central directory and `manifest.json`, and validates — before any other
 * entry is touched — the entry count, every entry name, per-entry and total
 * uncompressed size (zip-bomb guard), and that the zip's entry set equals the
 * manifest's. Entry reads verify size and SHA-256 against the manifest.
 *
 * The byte source is abstract (a range reader), so the daemon can read a pack
 * straight out of the upload staging store (local disk or S3) without a
 * temporary file.
 */

import { createHash } from 'node:crypto';
import { PassThrough, type Readable, Transform } from 'node:stream';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import type { z } from 'zod';
import {
  AGOR_PACK,
  type AgorPackEntry,
  type AgorPackManifest,
  agorPackManifestSchema,
} from '../types/agor-pack';
import { AgorPackFormatError, assertAgorPackEntryPath, teammateKeyOfPath } from './paths';
import { computePackContentSha256 } from './zip-writer';

/** A byte range reader: `[start, end)` of the pack. */
export interface AgorPackByteSource {
  size: number;
  readRange(start: number, end: number): Readable | Promise<Readable>;
  close?(): Promise<void> | void;
}

export function bufferByteSource(buffer: Buffer): AgorPackByteSource {
  return {
    size: buffer.byteLength,
    readRange: (start, end) => {
      const stream = new PassThrough();
      stream.end(buffer.subarray(start, end));
      return stream;
    },
  };
}

class SourceReader extends yauzl.RandomAccessReader {
  constructor(private readonly source: AgorPackByteSource) {
    super();
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const out = new PassThrough();
    Promise.resolve(this.source.readRange(start, end))
      .then((stream) => {
        stream.once('error', (error) => out.destroy(error));
        stream.pipe(out);
      })
      .catch((error: unknown) =>
        out.destroy(error instanceof Error ? error : new Error(String(error)))
      );
    return out;
  }

  override close(callback: (err: Error | null) => void): void {
    Promise.resolve(this.source.close?.())
      .then(() => callback(null))
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error(String(error)))
      );
  }
}

function openZip(source: AgorPackByteSource): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      new SourceReader(source),
      source.size,
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zip) =>
        error ? reject(new AgorPackFormatError(`Not a valid zip: ${error.message}`)) : resolve(zip)
    );
  });
}

function readCentralDirectory(zip: ZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>();
    let total = 0;
    const fail = (error: Error) => {
      zip.removeAllListeners('entry');
      reject(error);
    };
    zip.on('entry', (entry: Entry) => {
      try {
        if (entries.size >= AGOR_PACK.maxEntries) {
          throw new AgorPackFormatError(`Pack has more than ${AGOR_PACK.maxEntries} entries`);
        }
        const name = entry.fileName;
        if (name.endsWith('/'))
          throw new AgorPackFormatError(`Pack has a directory entry: ${name}`);
        assertAgorPackEntryPath(name);
        if (entries.has(name)) throw new AgorPackFormatError(`Duplicate pack entry: ${name}`);
        if (entry.isEncrypted()) throw new AgorPackFormatError(`Encrypted pack entry: ${name}`);
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          throw new AgorPackFormatError(`Unsupported compression in pack entry: ${name}`);
        }
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode !== 0 && mode !== 0o100000) {
          throw new AgorPackFormatError(`Pack entry is not a regular file: ${name}`);
        }
        if (entry.uncompressedSize > AGOR_PACK.maxEntryBytes) {
          throw new AgorPackFormatError(`Pack entry is too large: ${name}`);
        }
        total += entry.uncompressedSize;
        if (total > AGOR_PACK.maxUncompressedBytes) {
          throw new AgorPackFormatError('Pack exceeds the maximum uncompressed size');
        }
        entries.set(name, entry);
        zip.readEntry();
      } catch (error) {
        fail(error as Error);
      }
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', (error: Error) => fail(new AgorPackFormatError(error.message)));
    zip.readEntry();
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)));
  });
}

async function collect(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).byteLength;
    if (size > limit) {
      stream.destroy();
      throw new AgorPackFormatError('Pack entry exceeds the readable size limit');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export class AgorPackReader {
  private constructor(
    private readonly zip: ZipFile,
    private readonly zipEntries: Map<string, Entry>,
    private readonly declared: Map<string, AgorPackEntry>,
    readonly manifest: AgorPackManifest
  ) {}

  static async open(source: AgorPackByteSource): Promise<AgorPackReader> {
    if (source.size > AGOR_PACK.maxBytes) {
      throw new AgorPackFormatError('Pack exceeds the maximum size');
    }
    const zip = await openZip(source);
    try {
      const zipEntries = await readCentralDirectory(zip);
      const manifestEntry = zipEntries.get(AGOR_PACK.manifestPath);
      if (!manifestEntry) throw new AgorPackFormatError('Pack has no manifest.json');
      const raw = await collect(
        await openEntryStream(zip, manifestEntry),
        AGOR_PACK.maxTextEntryBytes
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new AgorPackFormatError('Pack manifest is not valid JSON');
      }
      const result = agorPackManifestSchema.safeParse(parsed);
      if (!result.success) {
        throw new AgorPackFormatError(
          `Pack manifest is invalid: ${result.error.issues[0]?.path.join('.') ?? ''} ${result.error.issues[0]?.message ?? ''}`.trim()
        );
      }
      const manifest = result.data;
      const declared = new Map(manifest.entries.map((entry) => [entry.path, entry]));
      if (declared.size !== manifest.entries.length) {
        throw new AgorPackFormatError('Pack manifest lists an entry twice');
      }
      if (computePackContentSha256(manifest.entries) !== manifest.content_sha256) {
        throw new AgorPackFormatError('Pack manifest content hash does not match its entries');
      }
      const keys = new Set(manifest.teammates.map((teammate) => teammate.key));
      if (keys.size !== manifest.teammates.length) {
        throw new AgorPackFormatError('Pack manifest lists a teammate key twice');
      }
      for (const [name, entry] of zipEntries) {
        if (name === AGOR_PACK.manifestPath) continue;
        const expected = declared.get(name);
        if (!expected) throw new AgorPackFormatError(`Pack entry is not in the manifest: ${name}`);
        if (expected.bytes !== entry.uncompressedSize) {
          throw new AgorPackFormatError(`Pack entry size does not match the manifest: ${name}`);
        }
        const key = teammateKeyOfPath(name);
        if (!key || !keys.has(key)) {
          throw new AgorPackFormatError(`Pack entry belongs to an unknown teammate: ${name}`);
        }
      }
      for (const path of declared.keys()) {
        if (!zipEntries.has(path)) {
          throw new AgorPackFormatError(`Pack is missing an entry listed in the manifest: ${path}`);
        }
      }
      return new AgorPackReader(zip, zipEntries, declared, manifest);
    } catch (error) {
      zip.close();
      throw error;
    }
  }

  has(path: string): boolean {
    return this.declared.has(path);
  }

  /** Declared entries whose path starts with `prefix`, sorted. */
  list(prefix: string): AgorPackEntry[] {
    return [...this.declared.values()]
      .filter((entry) => entry.path.startsWith(prefix))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** POSIX permission bits recorded for an entry (0 when absent). */
  mode(path: string): number {
    const entry = this.zipEntries.get(path);
    return entry ? (entry.externalFileAttributes >>> 16) & 0o777 : 0;
  }

  /** Stream an entry; the stream errors if its bytes do not match the manifest. */
  async openStream(path: string): Promise<Readable> {
    const entry = this.zipEntries.get(path);
    const expected = this.declared.get(path);
    if (!entry || !expected) throw new AgorPackFormatError(`Pack has no entry ${path}`);
    const source = await openEntryStream(this.zip, entry);
    const hash = createHash('sha256');
    let bytes = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        hash.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) {
          callback(new AgorPackFormatError(`Pack entry failed its integrity check: ${path}`));
          return;
        }
        callback();
      },
    });
    source.once('error', (error) => verify.destroy(error));
    return source.pipe(verify);
  }

  async readBuffer(path: string, limit: number = AGOR_PACK.maxTextEntryBytes): Promise<Buffer> {
    return collect(await this.openStream(path), limit);
  }

  async readText(path: string): Promise<string> {
    return (await this.readBuffer(path)).toString('utf8');
  }

  async readJson<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.readText(path));
    } catch (error) {
      if (error instanceof AgorPackFormatError) throw error;
      throw new AgorPackFormatError(`Pack entry is not valid JSON: ${path}`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new AgorPackFormatError(
        `Pack entry ${path} is invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim()
      );
    }
    return result.data;
  }

  close(): void {
    this.zip.close();
  }
}
