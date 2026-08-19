import { Readable } from 'node:stream';
import type {
  UploadMetadata,
  UploadOwner,
  UploadReadInput,
  UploadRef,
  UploadStageInput,
  UploadStagingStore,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  consumeDiscordThreadHistorySnapshot,
  stageDiscordThreadHistorySnapshot,
} from './discord-thread-history-rpc.js';

const REF = 'upl_00000000-0000-4000-8000-000000000099' as UploadRef;
const owner = {
  tenantId: 'tenant-a',
  sessionId: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
  branchId: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a70',
  createdBy: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a71',
} as UploadOwner;

function snapshot() {
  return {
    version: 1 as const,
    initial_message_id: '523456789012345678' as const,
    through_message_id: '623456789012345678' as const,
    messages: [
      {
        message_id: '523456789012345678' as const,
        iso_time: '2026-08-18T12:00:00.000Z',
        actor_label: 'caller',
        text: 'untrusted content',
      },
    ],
    has_more: false,
    next_message_id: '523456789012345678' as const,
  };
}

class MemoryStore implements UploadStagingStore {
  bytes?: Buffer;
  metadata?: UploadMetadata;
  stagedOwner?: UploadOwner;
  consume = vi.fn(async () => {
    this.bytes = undefined;
    this.metadata = undefined;
  });
  delete = vi.fn(async () => {
    this.bytes = undefined;
    this.metadata = undefined;
  });

  async stage(input: UploadStageInput): Promise<UploadMetadata> {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    this.bytes = Buffer.concat(chunks);
    this.stagedOwner = input.owner;
    this.metadata = {
      ref: REF,
      name: input.name,
      mimeType: input.mimeType,
      size: this.bytes.byteLength,
      createdAt: '2026-08-18T12:00:00.000Z',
      expiresAt: '2026-08-18T12:02:00.000Z',
      provenance: input.provenance,
    };
    return this.metadata;
  }

  private authorize(input: UploadReadInput): void {
    if (
      input.tenantId !== this.stagedOwner?.tenantId ||
      input.sessionId !== this.stagedOwner.sessionId ||
      input.branchId !== this.stagedOwner.branchId ||
      input.ref !== REF
    ) {
      throw Object.assign(new Error('Upload not found'), { status: 404 });
    }
  }

  async inspect(input: UploadReadInput): Promise<UploadMetadata> {
    this.authorize(input);
    if (!this.metadata) throw new Error('Upload not found');
    return this.metadata;
  }

  async read(input: UploadReadInput): Promise<NodeJS.ReadableStream> {
    this.authorize(input);
    if (!this.bytes) throw new Error('Upload not found');
    return Readable.from(this.bytes);
  }

  async cleanupExpired(): Promise<number> {
    return 0;
  }
}

describe('Discord history staged RPC', () => {
  it('stages only a bounded opaque coordinate and consumes after verification', async () => {
    const store = new MemoryStore();
    const result = await stageDiscordThreadHistorySnapshot(store, owner, snapshot());
    expect(result).toMatchObject({
      kind: 'discord_thread_history',
      upload_ref: REF,
      message_count: 1,
      has_more: false,
    });
    expect(JSON.stringify(result)).not.toContain('untrusted content');
    await expect(
      consumeDiscordThreadHistorySnapshot({
        store,
        owner,
        result,
      })
    ).resolves.toEqual(snapshot());
    expect(store.consume).toHaveBeenCalledOnce();
    expect(store.bytes).toBeUndefined();
  });

  it('deletes an owned corrupt result but cannot read or delete a cross-session ref', async () => {
    const store = new MemoryStore();
    const result = await stageDiscordThreadHistorySnapshot(store, owner, snapshot());
    store.bytes![0] ^= 1;
    await expect(consumeDiscordThreadHistorySnapshot({ store, owner, result })).rejects.toThrow(
      /hash|malformed/
    );
    expect(store.delete).toHaveBeenCalledOnce();

    const otherStore = new MemoryStore();
    const otherResult = await stageDiscordThreadHistorySnapshot(otherStore, owner, snapshot());
    await expect(
      consumeDiscordThreadHistorySnapshot({
        store: otherStore,
        owner: { ...owner, sessionId: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5aff' },
        result: otherResult,
      })
    ).rejects.toThrow('Upload not found');
    expect(otherStore.delete).not.toHaveBeenCalled();
  });
});
