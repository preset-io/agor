import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DISCORD_THREAD_HISTORY_SNAPSHOT_MAX_BYTES,
  DISCORD_THREAD_HISTORY_STAGED_READ_TIMEOUT_MS,
  DISCORD_THREAD_HISTORY_STAGING_TTL_MS,
  type DiscordThreadHistorySnapshot,
  parseDiscordThreadHistorySnapshot,
  serializeDiscordThreadHistorySnapshot,
} from '@agor/core/gateway';
import type {
  BranchID,
  GatewayProviderActionResultMetadata,
  SessionID,
  TenantID,
  UploadOwner,
  UploadReadInput,
  UploadRef,
  UploadStagingStore,
  UserID,
} from '@agor/core/types';

const HISTORY_SNAPSHOT_NAME = 'discord-thread-history.json';
const HISTORY_SNAPSHOT_MIME = 'application/json';

export interface DiscordThreadHistoryStageOwner {
  tenantId: TenantID;
  sessionId: SessionID;
  branchId: BranchID;
  createdBy: UserID;
}

function snapshotDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stage the only content-bearing part of the cross-daemon history RPC. */
export async function stageDiscordThreadHistorySnapshot(
  store: UploadStagingStore,
  owner: DiscordThreadHistoryStageOwner,
  snapshot: DiscordThreadHistorySnapshot
): Promise<Extract<GatewayProviderActionResultMetadata, { kind: 'discord_thread_history' }>> {
  const bytes = serializeDiscordThreadHistorySnapshot(snapshot);
  const staged = await store.stage({
    owner: owner as UploadOwner,
    name: HISTORY_SNAPSHOT_NAME,
    mimeType: HISTORY_SNAPSHOT_MIME,
    provenance: 'mcp-discord',
    body: Readable.from(bytes),
    sizeHint: bytes.byteLength,
    ttlMs: DISCORD_THREAD_HISTORY_STAGING_TTL_MS,
  });
  const createdAt = Date.parse(staged.createdAt);
  const expiresAt = staged.expiresAt ? Date.parse(staged.expiresAt) : Number.NaN;
  if (
    staged.name !== HISTORY_SNAPSHOT_NAME ||
    staged.mimeType !== HISTORY_SNAPSHOT_MIME ||
    staged.provenance !== 'mcp-discord' ||
    staged.size !== bytes.byteLength ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > DISCORD_THREAD_HISTORY_STAGING_TTL_MS
  ) {
    await store.delete({ ...owner, ref: staged.ref }).catch(() => undefined);
    throw new Error('Discord history staging returned invalid metadata');
  }
  return {
    kind: 'discord_thread_history',
    upload_ref: staged.ref,
    sha256: snapshotDigest(bytes),
    byte_length: bytes.byteLength,
    message_count: snapshot.messages.length,
    has_more: snapshot.has_more,
    ...(snapshot.next_message_id ? { next_message_id: snapshot.next_message_id } : {}),
  };
}

async function readStreamBounded(
  stream: NodeJS.ReadableStream,
  expectedBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let finished = false;
  const fail = (reason: Error) => {
    if (finished) return;
    finished = true;
    if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy(reason);
  };
  const deadline = setTimeout(
    () => fail(new Error('Discord history staged read timed out')),
    DISCORD_THREAD_HISTORY_STAGED_READ_TIMEOUT_MS
  );
  deadline.unref?.();
  const onAbort = () =>
    fail(
      signal?.reason instanceof Error ? signal.reason : new Error('Discord history read aborted')
    );
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, 'utf8')
          : Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      if (size > expectedBytes || size > DISCORD_THREAD_HISTORY_SNAPSHOT_MAX_BYTES) {
        fail(new Error('Discord history staged result exceeded its byte bound'));
        throw new Error('Discord history staged result exceeded its byte bound');
      }
      chunks.push(bytes);
    }
    finished = true;
    if (size !== expectedBytes) throw new Error('Discord history staged result size mismatched');
    return Buffer.concat(chunks, size);
  } finally {
    finished = true;
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Authorize, verify, consume, then expose one short-lived history snapshot. */
export async function consumeDiscordThreadHistorySnapshot(input: {
  store: UploadStagingStore;
  owner: Omit<DiscordThreadHistoryStageOwner, 'createdBy'>;
  result: Extract<GatewayProviderActionResultMetadata, { kind: 'discord_thread_history' }>;
  signal?: AbortSignal;
}): Promise<DiscordThreadHistorySnapshot> {
  const readInput: UploadReadInput = {
    ...input.owner,
    ref: input.result.upload_ref as UploadRef,
  };
  const metadata = await input.store.inspect(readInput);
  let authorized = true;
  try {
    if (
      metadata.name !== HISTORY_SNAPSHOT_NAME ||
      metadata.mimeType !== HISTORY_SNAPSHOT_MIME ||
      metadata.provenance !== 'mcp-discord' ||
      metadata.size !== input.result.byte_length ||
      metadata.size < 1 ||
      metadata.size > DISCORD_THREAD_HISTORY_SNAPSHOT_MAX_BYTES
    ) {
      throw new Error('Discord history staged metadata is invalid');
    }
    const stream = await input.store.read(readInput);
    const bytes = await readStreamBounded(stream, input.result.byte_length, input.signal);
    if (snapshotDigest(bytes) !== input.result.sha256) {
      throw new Error('Discord history staged result hash mismatched');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('Discord history staged result is malformed');
    }
    const snapshot = parseDiscordThreadHistorySnapshot(decoded);
    if (
      snapshot.messages.length !== input.result.message_count ||
      snapshot.has_more !== input.result.has_more ||
      snapshot.next_message_id !== input.result.next_message_id
    ) {
      throw new Error('Discord history staged result does not match its coordinate');
    }
    await input.store.consume(readInput);
    authorized = false;
    return snapshot;
  } finally {
    if (authorized) await input.store.delete(readInput).catch(() => undefined);
  }
}
