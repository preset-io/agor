/**
 * Client for the resumable pack upload (`/agor-pack/uploads/chunked`, see
 * `AgorPackChunkedUpload`). Transport-agnostic and browser-safe: the caller
 * supplies `send` (base URL and auth; it resolves with any HTTP response and
 * rejects only when the request never completed) and `readChunk`. The CLI,
 * the UI, and daemon-to-workspace sends all use it.
 *
 * Every request is retried with backoff on network errors, 5xx, 408 and 429.
 * Starting the same file again resumes it: the server answers `init` with the
 * chunks it already has, and re-sending a chunk it has is a no-op.
 */

import {
  type AgorPackChunkedUpload,
  type AgorPackImport,
  agorPackChunkLength,
} from '../types/agor-pack';

export const AGOR_PACK_CHUNKED_UPLOAD_PATH = '/agor-pack/uploads/chunked';

export type AgorPackUploadSend = (
  path: string,
  init: {
    method: 'GET' | 'POST' | 'PUT';
    headers?: Record<string, string>;
    body?: string | Blob | Uint8Array;
  }
) => Promise<Response>;

export interface AgorPackChunkedUploadOptions {
  size: number;
  /** SHA-256 (hex) of the whole file; the server checks it before staging. */
  sha256: string;
  /** Bytes [start, end) of the file. */
  readChunk: (start: number, end: number) => Promise<Blob | Uint8Array>;
  send: AgorPackUploadSend;
  onProgress?: (uploadedBytes: number, size: number) => void;
  /** Attempts per request before giving up (default 5). */
  attempts?: number;
  /** First backoff delay; doubles per attempt (default 1000 ms). */
  retryDelayMs?: number;
  signal?: AbortSignal;
}

export class AgorPackUploadError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null when the request never completed. */
    readonly status: number | null
  ) {
    super(message);
    this.name = 'AgorPackUploadError';
  }
}

const retryable = (status: number | null) =>
  status === null || status === 408 || status === 429 || status >= 500;

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? `Upload failed (${response.status})`;
  } catch {
    return `Upload failed (${response.status})`;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

async function call<T>(
  options: AgorPackChunkedUploadOptions,
  path: string,
  init: Parameters<AgorPackUploadSend>[1]
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 5);
  const delay = options.retryDelayMs ?? 1000;
  let last: AgorPackUploadError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.signal?.throwIfAborted();
    let response: Response | null = null;
    try {
      response = await options.send(path, init);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      last = new AgorPackUploadError(`Upload interrupted: ${reason}`, null);
    }
    if (response?.ok) return (await response.json()) as T;
    if (response) {
      last = new AgorPackUploadError(await errorText(response), response.status);
      if (!retryable(response.status)) throw last;
    }
    if (attempt < attempts) await sleep(delay * 2 ** (attempt - 1), options.signal);
  }
  throw last as AgorPackUploadError;
}

/** Upload (or resume) a pack and return its dry-run receipt. */
export async function uploadPackChunked(
  options: AgorPackChunkedUploadOptions
): Promise<AgorPackImport> {
  const { size, sha256 } = options;
  // A second pass covers chunks that went missing before `complete` (409).
  for (let pass = 1; ; pass++) {
    const state = await call<AgorPackChunkedUpload>(options, AGOR_PACK_CHUNKED_UPLOAD_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size, sha256 }),
    });
    const base = `${AGOR_PACK_CHUNKED_UPLOAD_PATH}/${state.upload_id}`;
    if (!state.import_id) {
      const have = new Set(state.received);
      let uploaded = state.received.reduce(
        (sum, index) => sum + agorPackChunkLength(size, index, state.chunk_size),
        0
      );
      options.onProgress?.(uploaded, size);
      for (let index = 0; index < state.chunks; index++) {
        if (have.has(index)) continue;
        const start = index * state.chunk_size;
        const end = Math.min(size, start + state.chunk_size);
        const body = await options.readChunk(start, end);
        await call(options, `${base}/${index}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body,
        });
        uploaded += end - start;
        options.onProgress?.(uploaded, size);
      }
    }
    try {
      return await call<AgorPackImport>(options, `${base}/complete`, { method: 'POST' });
    } catch (error) {
      if (pass < 2 && error instanceof AgorPackUploadError && error.status === 409) continue;
      throw error;
    }
  }
}
