import { runWithTenantDatabaseScope, SessionRepository, UploadRepository } from '@agor/core/db';
import type {
  SessionID,
  TenantID,
  UploadMetadata,
  UploadOwner,
  UploadReadInput,
  UploadStageInput,
  UploadStagingStore,
  UserID,
} from '@agor/core/types';

function sanitizeHomeSegment(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Application-level composition of the byte-store port and the database
 * control plane. All ingress paths receive this same instance.
 */
export class MetadataUploadStagingStore implements UploadStagingStore {
  private readonly repository: UploadRepository;
  private readonly sessions: SessionRepository;

  constructor(
    private readonly db: ConstructorParameters<typeof UploadRepository>[0],
    private readonly bytes: UploadStagingStore
  ) {
    this.repository = new UploadRepository(db);
    this.sessions = new SessionRepository(db);
  }

  // Session unix_username is immutable, so the key survives a user rename.
  private async resolveHomeSegment(
    tenantId: TenantID,
    sessionId: SessionID,
    createdBy: UserID
  ): Promise<string> {
    const session = await runWithTenantDatabaseScope(this.db, tenantId, () =>
      this.sessions.findById(sessionId)
    );
    return (
      sanitizeHomeSegment(session?.unix_username) ?? sanitizeHomeSegment(createdBy) ?? '_shared'
    );
  }

  async stage(input: UploadStageInput): Promise<UploadMetadata> {
    const homeSegment = await this.resolveHomeSegment(
      input.owner.tenantId,
      input.owner.sessionId,
      input.owner.createdBy
    );
    const metadata = await this.bytes.stage({ ...input, homeSegment });
    try {
      await runWithTenantDatabaseScope(this.db, input.owner.tenantId, () =>
        this.repository.create(input.owner, metadata)
      );
      return metadata;
    } catch (error) {
      await this.bytes
        .delete({ ...input.owner, ref: metadata.ref, homeSegment })
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
    const upload = await this.authorize(input);
    const homeSegment = await this.resolveHomeSegment(
      input.tenantId,
      upload.sessionId,
      upload.createdBy
    );
    return this.bytes.inspect({ ...input, homeSegment });
  }

  async read(
    input: UploadReadInput & { offset?: number; length?: number }
  ): Promise<NodeJS.ReadableStream> {
    const upload = await this.authorize(input);
    const homeSegment = await this.resolveHomeSegment(
      input.tenantId,
      upload.sessionId,
      upload.createdBy
    );
    return this.bytes.read({ ...input, homeSegment });
  }

  async consume(input: UploadReadInput): Promise<void> {
    const existing = await runWithTenantDatabaseScope(this.db, input.tenantId, () =>
      this.repository.findOwned(input.tenantId, input.ref)
    );
    if (!existing) return;
    if (existing.sessionId !== input.sessionId || existing.branchId !== input.branchId) {
      throw Object.assign(new Error('Upload not found'), { status: 404 });
    }
    const homeSegment = await this.resolveHomeSegment(
      input.tenantId,
      existing.sessionId,
      existing.createdBy
    );
    await this.bytes.consume({ ...input, homeSegment });
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
    const homeSegment = await this.resolveHomeSegment(
      input.tenantId,
      existing.sessionId,
      existing.createdBy
    );
    await this.bytes.delete({ ...input, homeSegment });
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
