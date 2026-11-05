import { randomUUID } from 'node:crypto';
import { runWithTenantDatabaseScope, StagedBlobRepository, UploadRepository } from '@agor/core/db';
import type {
  BlobStagingStore,
  StagedBlob,
  StagedBlobOwner,
  StagedBlobReadInput,
  UploadMetadata,
  UploadOwner,
  UploadReadInput,
  UploadRef,
  UploadStageInput,
  UploadStagingStore,
} from '@agor/core/types';

/**
 * Application-level composition of the byte-store port and the database
 * control plane. All ingress paths receive this same instance.
 */
export class MetadataUploadStagingStore implements UploadStagingStore {
  private readonly repository: UploadRepository;
  /** Non-attachment blobs (`.agorpack` files), when a blob byte namespace is configured. */
  readonly blobs?: BlobStagingStore;

  constructor(
    private readonly db: ConstructorParameters<typeof UploadRepository>[0],
    private readonly bytes: UploadStagingStore,
    blobs?: { bytes: UploadStagingStore; ttlMs: number }
  ) {
    this.repository = new UploadRepository(db);
    if (blobs) this.blobs = new MetadataBlobStagingStore(db, blobs.bytes, blobs.ttlMs);
  }

  async stage(input: UploadStageInput): Promise<UploadMetadata> {
    // Only trusted daemon code (an `.agorpack` import restoring an attachment
    // under its original ref) passes a reserved ref; requests never do.
    const ref = input.reservedRef ?? (`upl_${randomUUID()}` as UploadRef);
    await runWithTenantDatabaseScope(this.db, input.owner.tenantId, () =>
      this.repository.reserve(input.owner, {
        ref,
        name: input.name,
        mimeType: input.mimeType,
        size: 0,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        provenance: input.provenance,
      })
    );
    try {
      const metadata = await this.bytes.stage({ ...input, reservedRef: ref });
      if (metadata.ref !== ref) throw new Error('Upload adapter changed reserved identity');
      await runWithTenantDatabaseScope(this.db, input.owner.tenantId, () =>
        this.repository.complete(input.owner, metadata)
      );
      return metadata;
    } catch (error) {
      // Retain the reservation when byte settlement cannot be verified.
      await this.bytes
        .delete({ ...input.owner, ref })
        .then(() =>
          runWithTenantDatabaseScope(this.db, input.owner.tenantId, () =>
            this.repository.remove(input.owner.tenantId, ref)
          )
        )
        .catch(() => undefined);
      throw error;
    }
  }

  private async authorize(input: UploadReadInput) {
    const upload = await runWithTenantDatabaseScope(this.db, input.tenantId, () =>
      this.repository.findOwned(input.tenantId, input.ref)
    );
    if (
      upload?.status !== 'active' ||
      upload.sessionId !== input.sessionId ||
      upload.branchId !== input.branchId
    ) {
      throw Object.assign(new Error('Upload not found'), { status: 404 });
    }
    return upload;
  }

  async inspect(input: UploadReadInput): Promise<UploadMetadata> {
    await this.authorize(input);
    return this.bytes.inspect(input);
  }

  async read(
    input: UploadReadInput & { offset?: number; length?: number }
  ): Promise<NodeJS.ReadableStream> {
    await this.authorize(input);
    return this.bytes.read(input);
  }

  async consume(input: UploadReadInput): Promise<void> {
    const existing = await runWithTenantDatabaseScope(this.db, input.tenantId, () =>
      this.repository.findOwned(input.tenantId, input.ref)
    );
    if (!existing) return;
    if (existing.sessionId !== input.sessionId || existing.branchId !== input.branchId) {
      throw Object.assign(new Error('Upload not found'), { status: 404 });
    }
    await this.bytes.consume(input);
    await runWithTenantDatabaseScope(this.db, input.tenantId, () =>
      this.repository.remove(input.tenantId, input.ref)
    );
  }

  async delete(input: UploadReadInput): Promise<void> {
    const existing = await runWithTenantDatabaseScope(this.db, input.tenantId, () =>
      this.repository.findOwned(input.tenantId, input.ref)
    );
    if (!existing) return;
    if (existing.sessionId !== input.sessionId || existing.branchId !== input.branchId) {
      throw Object.assign(new Error('Upload not found'), { status: 404 });
    }
    await this.bytes.delete(input);
    await runWithTenantDatabaseScope(this.db, input.tenantId, () =>
      this.repository.remove(input.tenantId, input.ref)
    );
  }

  async cleanupExpired(owner: Pick<UploadOwner, 'tenantId'>, now = new Date()): Promise<number> {
    const expired = await runWithTenantDatabaseScope(this.db, owner.tenantId, () =>
      this.repository.findExpired(owner.tenantId, now)
    );
    let removed = 0;
    for (const upload of expired) {
      const deleted = await this.delete({
        tenantId: upload.tenantId,
        sessionId: upload.sessionId,
        branchId: upload.branchId,
        ref: upload.ref,
      }).then(
        () => true,
        () => false
      );
      if (deleted) removed++;
    }
    // Also reconcile adapter-owned partial/orphan records.
    await this.bytes.cleanupExpired(owner, now);
    return removed;
  }
}

/**
 * Blob port: the `staged_blobs` row is the ownership and expiry authority,
 * checked before every byte operation. Bytes are staged without an adapter
 * expiry, so only the row (which an in-use import extends) decides when they go. Bytes sit in their own adapter
 * namespace; adapters bind each object to a (tenant, id, id) tuple, which for
 * blobs is (tenant, scope, creator).
 */
class MetadataBlobStagingStore implements BlobStagingStore {
  private readonly repository: StagedBlobRepository;

  constructor(
    private readonly db: ConstructorParameters<typeof UploadRepository>[0],
    private readonly bytes: UploadStagingStore,
    private readonly ttlMs: number
  ) {
    this.repository = new StagedBlobRepository(db);
  }

  private unit<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return runWithTenantDatabaseScope(this.db, tenantId, work);
  }

  private byteInput(owner: StagedBlobOwner, ref: UploadRef): UploadReadInput {
    return {
      tenantId: owner.tenantId,
      sessionId: owner.scopeId as UploadReadInput['sessionId'],
      branchId: owner.createdBy as unknown as UploadReadInput['branchId'],
      ref,
    };
  }

  async stage(input: Parameters<BlobStagingStore['stage']>[0]): Promise<UploadMetadata> {
    const ref = `upl_${randomUUID()}` as UploadRef;
    const { owner } = input;
    await this.unit(owner.tenantId, () =>
      this.repository.reserve(owner, ref, new Date(Date.now() + this.ttlMs))
    );
    const byteOwner = this.byteInput(owner, ref);
    try {
      const metadata = await this.bytes.stage({
        reservedRef: ref,
        owner: { ...byteOwner, createdBy: owner.createdBy },
        name: input.name,
        mimeType: input.mimeType,
        provenance: 'import',
        body: input.body,
        sizeHint: input.sizeHint,
        ttlMs: 0,
      });
      await this.unit(owner.tenantId, () => this.repository.complete(ref, metadata.size));
      return metadata;
    } catch (error) {
      await this.bytes
        .delete(byteOwner)
        .then(() => this.unit(owner.tenantId, () => this.repository.remove(ref)))
        .catch(() => undefined);
      throw error;
    }
  }

  private async authorize(input: StagedBlobReadInput, active = true): Promise<StagedBlob | null> {
    const blob = await this.unit(input.tenantId, () =>
      this.repository.find(input.tenantId, input.ref)
    );
    if (!blob) return null;
    if (
      (active && blob.status !== 'active') ||
      blob.kind !== input.kind ||
      blob.scopeId !== input.scopeId ||
      blob.createdBy !== input.createdBy
    ) {
      throw Object.assign(new Error('Upload not found'), { status: 404 });
    }
    return blob;
  }

  async inspect(input: StagedBlobReadInput): Promise<UploadMetadata> {
    if (!(await this.authorize(input))) {
      throw Object.assign(new Error('Upload not found'), { status: 404 });
    }
    return this.bytes.inspect(this.byteInput(input, input.ref));
  }

  async read(
    input: StagedBlobReadInput & { offset?: number; length?: number }
  ): Promise<NodeJS.ReadableStream> {
    if (!(await this.authorize(input))) {
      throw Object.assign(new Error('Upload not found'), { status: 404 });
    }
    return this.bytes.read({
      ...this.byteInput(input, input.ref),
      offset: input.offset,
      length: input.length,
    });
  }

  async touch(input: StagedBlobReadInput): Promise<void> {
    if (!(await this.authorize(input, false))) return;
    await this.unit(input.tenantId, () =>
      this.repository.extend(input.ref, new Date(Date.now() + this.ttlMs))
    );
  }

  async delete(input: StagedBlobReadInput): Promise<void> {
    if (!(await this.authorize(input, false))) return;
    await this.bytes.delete(this.byteInput(input, input.ref));
    await this.unit(input.tenantId, () => this.repository.remove(input.ref));
  }

  async cleanupExpired(owner: Pick<UploadOwner, 'tenantId'>, now = new Date()): Promise<number> {
    const expired = await this.unit(owner.tenantId, () =>
      this.repository.findExpired(owner.tenantId, now)
    );
    let removed = 0;
    for (const blob of expired) {
      const deleted = await this.delete({ ...blob, tenantId: owner.tenantId }).then(
        () => true,
        () => false
      );
      if (deleted) removed++;
    }
    await this.bytes.cleanupExpired(owner, now);
    return removed;
  }
}
