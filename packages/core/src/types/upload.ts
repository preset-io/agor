import type { BranchID, SessionID, UserID } from './id';
import type { TenantID } from './tenant';

/** Opaque identifier for bytes held at the ingress (boundary B) staging layer. */
export type UploadRef = string & { readonly __brand: 'UploadRef' };

/** Response header that correlates browser upload failures with daemon logs. */
export const UPLOAD_REQUEST_ID_HEADER = 'x-agor-upload-request-id';

/** Code/status pairs whose upload-policy messages are safe to display. */
export const UPLOAD_POLICY_ERROR_CONTRACT = {
  /**
   * Legacy: general uploads no longer restrict file types. Kept so clients and
   * daemons across the version boundary still render the reviewed message.
   */
  unsupportedMediaType: { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 },
  fileSize: { code: 'LIMIT_FILE_SIZE', status: 413 },
  totalFileSize: { code: 'LIMIT_TOTAL_FILE_SIZE', status: 413 },
  fileCount: { code: 'LIMIT_FILE_COUNT', status: 400 },
  unexpectedFile: { code: 'LIMIT_UNEXPECTED_FILE', status: 400 },
  payloadTooLarge: { code: 'PAYLOAD_TOO_LARGE', status: 413 },
} as const;

export type UploadPolicyErrorCode =
  (typeof UPLOAD_POLICY_ERROR_CONTRACT)[keyof typeof UPLOAD_POLICY_ERROR_CONTRACT]['code'];

export type UploadPolicyErrorDefinition =
  (typeof UPLOAD_POLICY_ERROR_CONTRACT)[keyof typeof UPLOAD_POLICY_ERROR_CONTRACT];

export function getUploadPolicyErrorDefinition(
  value: unknown
): UploadPolicyErrorDefinition | undefined {
  if (typeof value !== 'string') return undefined;
  return Object.values(UPLOAD_POLICY_ERROR_CONTRACT).find(
    (definition) => definition.code === value
  );
}

export type UploadProvenance =
  | 'browser'
  | 'gateway-slack'
  | 'gateway-discord'
  | 'gateway-teams'
  | 'mcp-slack'
  /** Restored from a `.agor` import (and the staged pack itself). */
  | 'import';
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

/** Runtime-neutral shape used to describe staged uploads in agent prompts. */
export interface UploadPromptAttachment {
  ref: string;
  filename: string;
  mimeType: string;
  size: number;
}

export const UPLOAD_VIRTUAL_URL_PREFIX = 'https://agor.live/_uploads/';

/**
 * Raster image types the browser may preview (thumbnails, inline display).
 * SVG is excluded because it can carry script.
 */
export const UPLOAD_PREVIEW_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * Upload media types that may be displayed from the Agor origin. Any file type
 * may be uploaded, so the declared MIME is client-controlled: everything
 * outside this set (HTML, SVG, XML, JS, ...) is served as an opaque
 * `application/octet-stream` attachment so it can never render as active
 * content under the Agor origin (stored XSS).
 */
export const UPLOAD_INLINE_MIME_TYPES: ReadonlySet<string> = new Set([
  ...UPLOAD_PREVIEW_IMAGE_MIME_TYPES,
  'application/pdf',
]);

/** Bare, lower-cased media type (drops `; charset=...` style parameters). */
export function normalizeUploadMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';', 1)[0].trim().toLowerCase();
}

/** How an upload with the given declared MIME may be served back to a browser. */
export function resolveUploadServeType(mimeType: string | null | undefined): {
  contentType: string;
  inline: boolean;
} {
  const normalized = normalizeUploadMimeType(mimeType);
  return UPLOAD_INLINE_MIME_TYPES.has(normalized)
    ? { contentType: normalized, inline: true }
    : { contentType: 'application/octet-stream', inline: false };
}

/** Public, resolved ingress limits shared by daemon and browser clients. */
export interface UploadIngressPolicy {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export function buildUploadAttachmentPrompt(
  text: string,
  attachments: readonly UploadPromptAttachment[]
): string {
  const trimmedText = text.trim();
  if (attachments.length === 0) return trimmedText;
  const attachmentBlock = [
    'Attachments — use `agor_upload_materialize` to access:',
    ...attachments.map(
      ({ ref, filename, mimeType, size }) =>
        `- [${filename}](${UPLOAD_VIRTUAL_URL_PREFIX}${ref}) (${mimeType}, ${formatUploadBytes(size)})`
    ),
  ].join('\n');
  if (trimmedText.startsWith('/')) return `${trimmedText}\n\n${attachmentBlock}`;
  return trimmedText ? `${attachmentBlock}\n\n${trimmedText}` : attachmentBlock;
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
  /** Internal durable staging reservation; never accepted from public ingress. */
  reservedRef?: UploadRef;
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

/**
 * Daemon-staged files that are not session attachments. They have their own
 * owner (the import/export they belong to and its user) instead of a
 * session/branch, their own byte namespace, and the same expiry sweep.
 */
/** `agor-pack-chunk`: one part of a resumable pack upload (and its bookkeeping). */
export type StagedBlobKind = 'agor-pack' | 'agor-pack-chunk';

export interface StagedBlobOwner {
  tenantId: TenantID;
  kind: StagedBlobKind;
  /** The import or export the bytes belong to. */
  scopeId: string;
  createdBy: UserID;
}

export type StagedBlobReadInput = StagedBlobOwner & { ref: UploadRef };

export interface StagedBlob {
  ref: UploadRef;
  tenantId: TenantID;
  kind: StagedBlobKind;
  scopeId: string;
  createdBy: UserID;
  size: number;
  status: 'pending' | 'active';
  createdAt: string;
  expiresAt: string;
}

/** Blob port of the upload staging store; every call re-checks the full owner. */
export interface BlobStagingStore {
  /** How long a blob is kept after it was staged or last claimed for use. */
  readonly ttlMs: number;
  stage(input: {
    owner: StagedBlobOwner;
    name: string;
    mimeType: string;
    body: NodeJS.ReadableStream;
    sizeHint?: number;
  }): Promise<UploadMetadata>;
  /**
   * A complete row without bytes under a caller-derived key, written by one
   * conditional insert (no pending state); `owner.scopeId` is its value.
   * False when the key already exists.
   */
  putRecord(owner: StagedBlobOwner, ref: UploadRef): Promise<boolean>;
  /** The caller's row under `ref` (any scope), or null. */
  findRecord(
    input: Omit<StagedBlobOwner, 'scopeId'> & { ref: UploadRef }
  ): Promise<StagedBlob | null>;
  inspect(input: StagedBlobReadInput): Promise<UploadMetadata>;
  read(
    input: StagedBlobReadInput & { offset?: number; length?: number }
  ): Promise<NodeJS.ReadableStream>;
  delete(input: StagedBlobReadInput): Promise<void>;
  /** The caller's blobs of one kind whose scope starts with `scopePrefix`. */
  list(input: Omit<StagedBlobOwner, 'scopeId'> & { scopePrefix: string }): Promise<StagedBlob[]>;
  /** Sweep one expired blob if it is still expired and not in use; true when removed. */
  sweepExpired(input: StagedBlobReadInput, now?: Date): Promise<boolean>;
  cleanupExpired(owner: Pick<UploadOwner, 'tenantId'>, now?: Date): Promise<number>;
}
