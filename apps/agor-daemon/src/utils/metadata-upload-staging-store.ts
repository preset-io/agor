import { runWithTenantDatabaseScope, UploadRepository } from '@agor/core/db';
import type {
  UploadMetadata,
  UploadOwner,
  UploadReadInput,
  UploadStageInput,
  UploadStagingStore,
} from '@agor/core/types';

/**
 * Application-level composition of the byte-store port and the database
 * control plane. All ingress paths receive this same instance.
 */
export class MetadataUploadStagingStore implements UploadStagingStore {
  private readonly repository: UploadRepository;

  constructor(
    private readonly db: ConstructorParameters<typeof UploadRepository>[0],
    private readonly bytes: UploadStagingStore
  ) {
    this.repository = new UploadRepository(db);
  }

  async stage(input: UploadStageInput): Promise<UploadMetadata> {
    await this.cleanupExpired({ tenantId: input.owner.tenantId }).catch(() => 0);
    const metadata = await this.bytes.stage(input);
    try {
      await runWithTenantDatabaseScope(this.db, input.owner.tenantId, () =>
        this.repository.create(input.owner, metadata)
      );
      return metadata;
    } catch (error) {
      await this.bytes.delete({ ...input.owner, ref: metadata.ref }).catch(() => undefined);
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
      await this.delete({
        tenantId: upload.tenantId,
        sessionId: upload.sessionId,
        branchId: upload.branchId,
        ref: upload.ref,
      }).catch(() => undefined);
      removed++;
    }
    // Also reconcile adapter-owned partial/orphan records.
    await this.bytes.cleanupExpired(owner, now);
    return removed;
  }
}
