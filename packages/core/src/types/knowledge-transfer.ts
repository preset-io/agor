import { z } from 'zod';
import {
  KNOWLEDGE_DOCUMENT_ICON_EMOJI_MAX_LENGTH,
  KNOWLEDGE_DOCUMENT_KINDS,
  KNOWLEDGE_DOCUMENT_STATUSES,
  type KnowledgeDocument,
  normalizeKnowledgePath,
} from './knowledge';

export const KNOWLEDGE_TRANSFER = {
  path: 'kb/transfers',
  format: 'agor-knowledge-namespace',
  version: 1,
  maxDocuments: 10_000,
  maxDocumentBytes: 10 * 1024 * 1024,
  // Leave headroom below the daemon HTTP JSON parser ceiling (10 MiB).
  maxRequestBytes: 9 * 1024 * 1024,
  // Aggregate encoded document requests, including metadata and JSON escaping.
  maxTotalRequestBytes: 110 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxManifestBytes: 10 * 1024 * 1024,
  pageSize: 100,
} as const;
export const knowledgeTransferHash = z.string().regex(/^[a-f0-9]{64}$/);
export const knowledgeTransferSlug = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const knowledgeTransferKey = z.string().regex(/^d[0-9]{6}$/);
const jsonObject = z.record(z.string(), z.unknown());
export const knowledgeTransferEntrySchema = z
  .object({
    key: knowledgeTransferKey,
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => {
        try {
          return normalizeKnowledgePath(value) === value;
        } catch {
          return false;
        }
      }, 'Invalid canonical Knowledge path'),
    title: z.string().max(4096),
    icon_emoji: z
      .string()
      .max(64)
      .refine((value) => [...value].length <= KNOWLEDGE_DOCUMENT_ICON_EMOJI_MAX_LENGTH)
      .nullable(),
    kind: z.enum(KNOWLEDGE_DOCUMENT_KINDS),
    status: z.enum(KNOWLEDGE_DOCUMENT_STATUSES),
    sha256: knowledgeTransferHash,
    bytes: z.number().int().min(0).max(KNOWLEDGE_TRANSFER.maxDocumentBytes),
    frontmatter: jsonObject.nullable(),
    provenance: jsonObject,
  })
  .strict();
export type KnowledgeTransferEntry = z.infer<typeof knowledgeTransferEntrySchema>;
export const knowledgeTransferManifestSchema = z
  .object({
    format: z.literal(KNOWLEDGE_TRANSFER.format),
    version: z.literal(1),
    completed: z.literal(true),
    consistency: z.literal('per-document-version; non-atomic-inventory'),
    exported_at: z.string().datetime(),
    namespace: z
      .object({
        slug: knowledgeTransferSlug,
        display_name: z.string().max(4096),
        description: z.string().max(16_384).nullable(),
        provenance: jsonObject,
      })
      .strict(),
    documents: z.array(knowledgeTransferEntrySchema).max(KNOWLEDGE_TRANSFER.maxDocuments),
    omissions: z.array(z.string().max(200)).max(20),
  })
  .strict();
export type KnowledgeTransferManifest = z.infer<typeof knowledgeTransferManifestSchema>;
/** Internal/source inventory projection: no body or binary columns. */
export interface KnowledgeTransferInventoryEntry {
  document_id: string;
  version_id: string | null;
  path: string;
  title: string;
  icon_emoji: string | null;
  kind: KnowledgeTransferEntry['kind'];
  status: KnowledgeTransferEntry['status'];
  sha256: string | null;
  bytes: number | null;
  mime_type: string | null;
  frontmatter: Record<string, unknown> | null;
  provenance: Record<string, unknown>;
}
export interface KnowledgeTransferReceipt {
  key: string;
  target_id: string;
  digest: string;
  unchanged: boolean;
  reconciled: boolean;
}
export interface KnowledgeTransferPage {
  namespace: KnowledgeTransferManifest['namespace'] | null;
  entries: KnowledgeTransferInventoryEntry[];
  receipts: KnowledgeTransferReceipt[];
  total: number;
  next_cursor: string | null;
}
export const knowledgeTransferWriteSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('namespace'),
      bundle: knowledgeTransferHash,
      slug: knowledgeTransferSlug,
      display_name: z.string().max(4096),
      description: z.string().max(16_384).nullable(),
      resume: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('document'),
      bundle: knowledgeTransferHash,
      slug: knowledgeTransferSlug,
      entry: knowledgeTransferEntrySchema,
      content: z.string().max(KNOWLEDGE_TRANSFER.maxDocumentBytes),
    })
    .strict(),
  z
    .object({
      action: z.literal('reconcile'),
      bundle: knowledgeTransferHash,
      slug: knowledgeTransferSlug,
      key: knowledgeTransferKey,
    })
    .strict(),
]);
export type KnowledgeTransferWrite = z.infer<typeof knowledgeTransferWriteSchema>;
export interface KnowledgeTransferWriteResult {
  target_id: string;
  skipped: boolean;
}
export interface KnowledgeTransferBody {
  content: string;
  sha256: string;
  bytes: number;
}

/** Typed DB projection, deliberately excludes body/blob fields. */
export type KnowledgeTransferInventoryRow = Omit<KnowledgeTransferInventoryEntry, 'provenance'> &
  Pick<
    KnowledgeDocument,
    | 'created_at'
    | 'updated_at'
    | 'created_by'
    | 'updated_by'
    | 'visibility'
    | 'edit_policy'
    | 'metadata'
  > & {
    version_metadata: Record<string, unknown> | null;
    version_number: number | null;
    change_summary: string | null;
    agentic_tool: string | null;
    teammate: string | null;
  };
export const knowledgeTransferCheckpointSchema = z
  .object({
    fingerprint: knowledgeTransferHash,
    sourceIdentity: z.string().min(1).max(1024),
    keys: z.record(z.string().uuid(), knowledgeTransferKey),
    nextKey: z.number().int().min(0).max(999999),
    exported_at: z.string().datetime(),
  })
  .strict();
