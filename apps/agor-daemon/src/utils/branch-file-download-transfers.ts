/**
 * Rendezvous registry for streamed branch-file downloads.
 *
 * The daemon has no filesystem access to branch checkouts — only the executor
 * does. A download therefore has two halves that must meet in the middle:
 *
 *   browser  GET /branches/:id/files/download   → registers a pending transfer
 *   executor POST /executor/files/downloads/:ref/content → claims it and streams
 *
 * This registry is the meeting point. It holds no file bytes and does no I/O
 * itself: the browser-facing route supplies a `sink` closure that pipes the
 * executor's request body straight into its own response, so bytes never land
 * in a buffer, a base64 string, or a Socket.IO frame.
 *
 * Entries are single-use and TTL-bounded, so a ref that is never claimed (the
 * executor died, the file was missing) cannot leak or be replayed.
 */

import { randomUUID } from 'node:crypto';

/** Identity a claiming executor must prove to receive a pending transfer. */
export interface DownloadTransferScope {
  tenantId: string;
  branchId: string;
  filePath: string;
  /** Upper bound the executor was authorized to send. */
  maxBytes: number;
}

export interface DownloadTransferMetadata {
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Consumes the executor's byte stream. Resolves once the bytes have been
 * handed to the browser, rejects if that delivery fails.
 */
export type DownloadTransferSink = (
  metadata: DownloadTransferMetadata,
  body: NodeJS.ReadableStream
) => Promise<void>;

/** A transfer taken off the registry by the executor that is about to stream. */
export interface ClaimedDownloadTransfer {
  scope: DownloadTransferScope;
  sink: DownloadTransferSink;
  /** Report delivery success (no argument) or failure to the waiting browser route. */
  settle: (error?: Error) => void;
}

interface PendingEntry extends ClaimedDownloadTransfer {
  timer: NodeJS.Timeout;
}

export interface RegisteredTransfer {
  /** Single-use handle handed to the executor. Matches `/^dl_[0-9a-f-]{36}$/`. */
  ref: string;
  /** Resolves when the executor's bytes have been delivered to the browser. */
  delivered: Promise<void>;
  /** Abandon the transfer (executor failed, client disconnected). Idempotent. */
  cancel: (reason?: string) => void;
}

/** Generous enough for executor spawn + Feathers connect, short enough to not leak. */
const DEFAULT_TTL_MS = 120_000;

export class BranchFileDownloadTransfers {
  private pending = new Map<string, PendingEntry>();

  constructor(private ttlMs: number = DEFAULT_TTL_MS) {}

  register(
    scope: DownloadTransferScope,
    sink: DownloadTransferSink,
    ttlMs: number = this.ttlMs
  ): RegisteredTransfer {
    const ref = `dl_${randomUUID()}`;
    let settled = false;
    let settleOuter: (error?: Error) => void = () => undefined;

    const delivered = new Promise<void>((resolve, reject) => {
      settleOuter = (error?: Error) => {
        if (settled) return;
        settled = true;
        const entry = this.pending.get(ref);
        if (entry) clearTimeout(entry.timer);
        this.pending.delete(ref);
        if (error) reject(error);
        else resolve();
      };
    });

    const timer = setTimeout(
      () => settleOuter(new Error('Download transfer expired before the executor delivered bytes')),
      ttlMs
    );
    // A pending download must never hold the process open on shutdown.
    timer.unref?.();

    this.pending.set(ref, { scope, sink, settle: settleOuter, timer });
    return {
      ref,
      delivered,
      cancel: (reason?: string) => settleOuter(new Error(reason ?? 'Download transfer cancelled')),
    };
  }

  /**
   * Take the pending transfer for `ref`, but only for a caller that proves the
   * same tenant and branch the transfer was registered for. Single-use: the
   * entry is removed here, so a replayed capability token finds nothing.
   */
  claim(ref: string, proof: { tenantId: string; branchId: string }): PendingEntry | null {
    const entry = this.pending.get(ref);
    if (!entry) return null;
    if (entry.scope.tenantId !== proof.tenantId || entry.scope.branchId !== proof.branchId) {
      return null;
    }
    clearTimeout(entry.timer);
    this.pending.delete(ref);
    return entry;
  }

  /** Test/observability helper. */
  get size(): number {
    return this.pending.size;
  }
}

let transfers: BranchFileDownloadTransfers | null = null;

export function getBranchFileDownloadTransfers(): BranchFileDownloadTransfers {
  if (!transfers) transfers = new BranchFileDownloadTransfers();
  return transfers;
}
