import type { BranchID, SessionID, UserID } from './id';
import type { TenantID } from './tenant';

/** Opaque identifier for bytes held at the ingress (boundary B) staging layer. */
export type UploadRef = string & { readonly __brand: 'UploadRef' };

export type UploadProvenance = 'browser' | 'gateway-slack' | 'mcp-slack';
export type UploadStatus = 'pending' | 'active' | 'deleting';

export interface UploadOwner {
  tenantId: TenantID;
  sessionId: SessionID;
  branchId: BranchID;
  createdBy: UserID;
}

export interface UploadMetadata {
  ref: UploadRef;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  expiresAt: string | null;
  provenance: UploadProvenance;
}

/** Persisted logical upload metadata. Storage keys are deliberately excluded. */
export interface Upload {
  ref: UploadRef;
  tenantId: TenantID;
  createdBy: UserID;
  sessionId: SessionID;
  branchId: BranchID;
  originalName: string;
  displayName: string;
  mimeType: string;
  size: number;
  checksum: string | null;
  status: UploadStatus;
  provenance: UploadProvenance;
  createdAt: string;
  expiresAt: string | null;
}

export interface UploadStageInput {
  owner: UploadOwner;
  name: string;
  mimeType: string;
  provenance: UploadProvenance;
  body: NodeJS.ReadableStream;
  sizeHint?: number;
  ttlMs?: number;
}

export interface UploadReadInput {
  tenantId: TenantID;
  sessionId: SessionID;
  branchId: BranchID;
  ref: UploadRef;
}

/**
 * Storage-neutral port for temporary ingress bytes. Implementations must
 * authorize every operation against owner, never disclose physical keys, and
 * enforce limits while streaming (size hints are not authoritative).
 */
export interface UploadStagingStore {
  stage(input: UploadStageInput): Promise<UploadMetadata>;
  inspect(input: UploadReadInput): Promise<UploadMetadata>;
  read(
    input: UploadReadInput & { offset?: number; length?: number }
  ): Promise<NodeJS.ReadableStream>;
  consume(input: UploadReadInput): Promise<void>;
  delete(input: UploadReadInput): Promise<void>;
  cleanupExpired(owner: Pick<UploadOwner, 'tenantId'>, now?: Date): Promise<number>;
}
