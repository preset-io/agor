/**
 * Resumable pack upload (see `AgorPackChunkedUpload` in `@agor/core/types`):
 * hosted ingress limits a request to far less than a pack, so the client
 * sends ≤ `AGOR_PACK.chunkBytes` chunks and the daemon assembles them into the
 * normal stage → dry-run once all are in.
 *
 * Every piece is a `agor-pack-chunk` blob of the staging store, owned by the
 * uploading user in their tenant (the blob row is the ownership authority,
 * re-checked on every read) and swept with the same TTL as packs:
 *
 *   <id>:i      zero bytes; its name records `<sha256>-<size>-<chunk size>`
 *   <id>:<n>    chunk n
 *   <id>:d      zero bytes after `complete`; its name is the receipt's import id.
 *               Its key is derived from (tenant, creator, upload), so it is
 *               published once; chunks are deleted only after it exists.
 *
 * `<id>` is derived from (sha256, size, chunk size), so starting the same file again
 * resumes it, and a `complete` whose response was lost can be repeated.
 */

import { createHash } from 'node:crypto';
import { pipeline, Readable, Transform } from 'node:stream';
import { assertTenantWritable, runWithTenantDatabaseScope } from '@agor/core/db';
import { BadRequest, Conflict, NotFound } from '@agor/core/feathers';
import {
  AGOR_PACK,
  type AgorPackChunkedUpload,
  type AgorPackChunkedUploadInit,
  type AgorPackImport,
  agorPackChunkCount,
  agorPackChunkLength,
  type BlobStagingStore,
  type StagedBlob,
  type StagedBlobOwner,
  type UploadRef,
  type UserID,
} from '@agor/core/types';
import { getBlobStagingStore } from '../utils/upload-staging.js';
import type { AgorPackServiceContext } from './agor-pack-export.js';
import type { AgorPackImporter } from './agor-pack-import.js';

const KIND = 'agor-pack-chunk';
const UPLOAD_ID = /^[0-9a-f]{24}$/;
const INFO = 'i';
const DONE = 'd';

function httpError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

let chunkBytes: number = AGOR_PACK.chunkBytes;

/** Chunk size of new uploads (tests use small chunks to exercise several). */
export function agorPackChunkBytes(): number {
  return chunkBytes;
}

export function setAgorPackChunkBytesForTests(bytes: number = AGOR_PACK.chunkBytes): void {
  chunkBytes = bytes;
}

export function agorPackChunkedUploadId(sha256: string, size: number, chunkSize: number): string {
  return createHash('sha256').update(`${sha256}:${size}:${chunkSize}`).digest('hex').slice(0, 24);
}

export class AgorPackChunkedUploads {
  private readonly store: BlobStagingStore = getBlobStagingStore();

  constructor(private readonly ctx: Pick<AgorPackServiceContext, 'db' | 'tenantId' | 'user'>) {}

  /** Nothing is staged while the tenant is write-gated. */
  private writable(): Promise<void> {
    return runWithTenantDatabaseScope(this.ctx.db, this.ctx.tenantId, () =>
      assertTenantWritable(this.ctx.db, this.ctx.tenantId)
    );
  }

  private owner(scopeId: string): StagedBlobOwner {
    return {
      tenantId: this.ctx.tenantId,
      kind: KIND,
      scopeId,
      createdBy: this.ctx.user.user_id as UserID,
    };
  }

  private blob(blob: StagedBlob) {
    return { ...this.owner(blob.scopeId), ref: blob.ref as UploadRef };
  }

  private async pieces(uploadId: string): Promise<StagedBlob[]> {
    if (!UPLOAD_ID.test(uploadId)) throw new NotFound('Upload not found');
    return this.store.list({
      tenantId: this.ctx.tenantId,
      kind: KIND,
      createdBy: this.ctx.user.user_id as UserID,
      scopePrefix: `${uploadId}:`,
    });
  }

  private async marker(pieces: StagedBlob[], suffix: string): Promise<string | null> {
    const blob = pieces.find(
      (piece) => piece.status === 'active' && piece.scopeId.endsWith(`:${suffix}`)
    );
    if (!blob) return null;
    return (await this.store.inspect(this.blob(blob))).name;
  }

  private async describe(uploadId: string, pieces: StagedBlob[]): Promise<AgorPackChunkedUpload> {
    const info = (await this.marker(pieces, INFO))?.match(/^([0-9a-f]{64})-([0-9]+)-([0-9]+)$/);
    if (!info) throw new NotFound('Upload not found');
    const size = Number(info[2]);
    const chunkSize = Number(info[3]);
    const received = new Set<number>();
    for (const piece of pieces) {
      const index = /:(\d+)$/.exec(piece.scopeId)?.[1];
      if (piece.status === 'active' && index !== undefined) received.add(Number(index));
    }
    return {
      upload_id: uploadId,
      size,
      sha256: info[1] as string,
      chunk_size: chunkSize,
      chunks: agorPackChunkCount(size, chunkSize),
      received: [...received].sort((a, b) => a - b),
      import_id: await this.marker(pieces, DONE),
    };
  }

  private async drop(pieces: StagedBlob[]): Promise<void> {
    for (const piece of pieces) {
      await this.store.delete(this.blob(piece)).catch(() => undefined);
    }
  }

  private async stageEmpty(scopeId: string, name: string, ref?: UploadRef): Promise<void> {
    await this.store.stage({
      owner: this.owner(scopeId),
      name,
      mimeType: 'application/octet-stream',
      body: Readable.from([]),
      sizeHint: 0,
      ...(ref ? { ref } : {}),
    });
  }

  /** A (v4-shaped) UUID derived from (tenant, creator, upload, purpose). */
  private derivedId(uploadId: string, purpose: string): string {
    const hex = createHash('sha256')
      .update(`${this.ctx.tenantId}:${this.ctx.user.user_id}:${uploadId}:${purpose}`)
      .digest('hex');
    const variant = '89ab'[Number.parseInt(hex[16] as string, 16) % 4];
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  /**
   * Publish the completed marker under its derived key: the first completer
   * inserts it, a concurrent one's insert fails on the key. True when ours.
   */
  private publishDone(uploadId: string, importId: string): Promise<boolean> {
    return this.stageEmpty(
      `${uploadId}:${DONE}`,
      importId,
      `upl_${this.derivedId(uploadId, 'done')}` as UploadRef
    ).then(
      () => true,
      () => false
    );
  }

  /** Start or resume the upload of a (size, sha256) file. */
  async init(
    input: AgorPackChunkedUploadInit,
    importer: Pick<AgorPackImporter, 'isUsable'>
  ): Promise<AgorPackChunkedUpload> {
    if (input.size > AGOR_PACK.maxBytes) throw httpError('Pack exceeds the maximum size', 413);
    await this.writable();
    const uploadId = agorPackChunkedUploadId(input.sha256, input.size, chunkBytes);
    let pieces = await this.pieces(uploadId);
    const done = await this.marker(pieces, DONE);
    // A finished upload is reused only while its receipt can still be applied.
    if (done && !(await importer.isUsable(done))) {
      await this.drop(pieces);
      pieces = [];
    }
    if (!(await this.marker(pieces, INFO))) {
      await this.stageEmpty(`${uploadId}:${INFO}`, `${input.sha256}-${input.size}-${chunkBytes}`);
      pieces = await this.pieces(uploadId);
    }
    return this.describe(uploadId, pieces);
  }

  async status(uploadId: string): Promise<AgorPackChunkedUpload> {
    return this.describe(uploadId, await this.pieces(uploadId));
  }

  /**
   * Store chunk `index` (exactly its expected length). A chunk the server
   * already has is kept and the body discarded, so a retry is harmless.
   */
  async putChunk(
    uploadId: string,
    index: number,
    body: NodeJS.ReadableStream,
    length: number
  ): Promise<AgorPackChunkedUpload> {
    const pieces = await this.pieces(uploadId);
    const state = await this.describe(uploadId, pieces);
    if (state.import_id) throw new Conflict('This upload is already complete');
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.chunks) {
      throw new BadRequest('Chunk index out of range');
    }
    const expected = agorPackChunkLength(state.size, index, state.chunk_size);
    if (length !== expected) {
      throw new BadRequest(`Chunk ${index} must be ${expected} bytes`);
    }
    if (state.received.includes(index)) {
      (body as Readable).resume?.();
      return state;
    }
    await this.writable();
    // An interrupted earlier attempt leaves a pending blob; replace it.
    await this.drop(pieces.filter((piece) => piece.scopeId === `${uploadId}:${index}`));
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength;
        callback(
          received > length ? new BadRequest('Chunk exceeds its declared size') : null,
          chunk
        );
      },
      flush(callback) {
        callback(received === length ? undefined : new BadRequest('Chunk size mismatch'));
      },
    });
    // `pipeline` fails the stage when the request is cut off mid-chunk.
    pipeline(body, limiter, () => undefined);
    await this.store.stage({
      owner: this.owner(`${uploadId}:${index}`),
      name: `chunk-${index}`,
      mimeType: 'application/octet-stream',
      body: limiter,
      sizeHint: length,
    });
    return this.describe(uploadId, await this.pieces(uploadId));
  }

  /**
   * Assemble the chunks in order, check the whole file's SHA-256, and stage it
   * through the importer (dry-run receipt). Repeating it returns the receipt.
   */
  /**
   * Assemble the chunks, check the whole file's SHA-256, and stage it through
   * the importer (dry-run receipt). Idempotent by ordering, so overlapping or
   * repeated calls all return the same receipt:
   *   1. the pack is staged under a scope derived from the upload (the
   *      importer keeps one receipt per pack content);
   *   2. the completed marker is published once (derived key);
   *   3. chunks are deleted only after the marker exists, and a completer
   *      that finds them gone returns the marker's receipt.
   */
  async complete(uploadId: string, importer: AgorPackImporter): Promise<AgorPackImport> {
    const pieces = await this.pieces(uploadId);
    const state = await this.describe(uploadId, pieces);
    if (state.import_id) return importer.get(state.import_id);
    await this.writable();
    return this.assemble(uploadId, importer, pieces, state);
  }

  /** The receipt of a completion another call finished, if any. */
  private async finished(
    uploadId: string,
    importer: AgorPackImporter
  ): Promise<AgorPackImport | null> {
    const done = await this.marker(await this.pieces(uploadId), DONE);
    return done ? importer.get(done) : null;
  }

  private async assemble(
    uploadId: string,
    importer: AgorPackImporter,
    pieces: StagedBlob[],
    state: AgorPackChunkedUpload
  ): Promise<AgorPackImport> {
    const missing = state.chunks - state.received.length;
    if (missing > 0) {
      const finished = await this.finished(uploadId, importer);
      if (finished) return finished;
      throw new Conflict(`The upload is missing ${missing} of ${state.chunks} chunks`);
    }
    const chunkOf = new Map<number, StagedBlob>();
    for (const piece of pieces) {
      const index = /:(\d+)$/.exec(piece.scopeId)?.[1];
      if (piece.status === 'active' && index !== undefined && !chunkOf.has(Number(index))) {
        chunkOf.set(Number(index), piece);
      }
    }
    const store = this.store;
    const blob = (piece: StagedBlob) => this.blob(piece);
    let checksumMismatch = false;
    // Pulled lazily by the stager, so a mismatch fails its read, not a stray stream.
    async function* verified() {
      const hash = createHash('sha256');
      for (let index = 0; index < state.chunks; index++) {
        const piece = chunkOf.get(index) as StagedBlob;
        for await (const chunk of (await store.read(blob(piece))) as AsyncIterable<Buffer>) {
          hash.update(chunk);
          yield chunk;
        }
      }
      if (hash.digest('hex') !== state.sha256) {
        checksumMismatch = true;
        throw new BadRequest("The uploaded file doesn't match its checksum; upload it again");
      }
    }
    let receipt: AgorPackImport;
    try {
      receipt = await importer.stage(Readable.from(verified()), state.size, {
        scopeId: this.derivedId(uploadId, 'pack'),
      });
    } catch (error) {
      // Corrupt chunks can't be told apart: start over.
      if (checksumMismatch) {
        await this.drop(pieces);
        throw error;
      }
      // Another completer may have finished and cleaned up the chunks.
      const finished = await this.finished(uploadId, importer);
      if (finished) return finished;
      throw error;
    }
    if (!(await this.publishDone(uploadId, receipt.import_id))) {
      // Another completer's marker (it may still be writing it). Without one
      // the chunks stay: they are the only way to finish the upload.
      let finished: AgorPackImport | null = null;
      for (let attempt = 0; attempt < 25 && !finished; attempt++) {
        finished = await this.finished(uploadId, importer);
        if (!finished) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!finished) throw new Error('The completed upload could not be recorded');
      receipt = finished;
    }
    await this.drop(pieces.filter((piece) => /:\d+$/.test(piece.scopeId)));
    return receipt;
  }
}
