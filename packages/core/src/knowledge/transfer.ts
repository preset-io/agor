import { createHash } from 'node:crypto';
import type {
  KnowledgeTransferEntry,
  KnowledgeTransferManifest,
  KnowledgeTransferWrite,
} from '../types/knowledge-transfer';
import { KNOWLEDGE_TRANSFER, knowledgeTransferManifestSchema } from '../types/knowledge-transfer';

export function transferSha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
/** Bounded JSON canonicalization: metadata must never become executable configuration. */
export function transferCanonical(value: unknown, depth = 0): string {
  if (depth > 20) throw new Error('Knowledge metadata exceeds maximum nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((v) => transferCanonical(v, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${transferCanonical((value as Record<string, unknown>)[key], depth + 1)}`
      )
      .join(',')}}`;
  throw new Error('Knowledge metadata must contain JSON values only');
}
export function transferDigest(value: unknown): string {
  return transferSha256(transferCanonical(value));
}
export function validateTransferManifest(value: unknown): KnowledgeTransferManifest {
  if (Buffer.byteLength(transferCanonical(value), 'utf8') > KNOWLEDGE_TRANSFER.maxManifestBytes)
    throw new Error('Manifest is too large');
  const manifest = knowledgeTransferManifestSchema.parse(value);
  const keys = new Set<string>();
  const paths = new Set<string>();
  let bytes = 0;
  for (const doc of manifest.documents) {
    if (keys.has(doc.key) || paths.has(doc.path)) throw new Error('Duplicate document key or path');
    keys.add(doc.key);
    paths.add(doc.path);
    bytes += doc.bytes;
  }
  if (bytes > KNOWLEDGE_TRANSFER.maxTotalBytes)
    throw new Error('Namespace exceeds transfer byte limit');
  return manifest;
}
/** Same encoded-request accounting for CLI planning and daemon admission. */
export function transferRequestBytes(request: KnowledgeTransferWrite): number {
  return Buffer.byteLength(transferCanonical(request), 'utf8');
}

/** Publish exactly the bounded bytes that our readers accept, with no pretty-print expansion. */
export function serializeTransferManifest(value: KnowledgeTransferManifest): string {
  const serialized = transferCanonical(validateTransferManifest(value));
  if (Buffer.byteLength(serialized, 'utf8') > KNOWLEDGE_TRANSFER.maxManifestBytes)
    throw new Error('Manifest is too large');
  return serialized;
}

/** Source policy/IDs stay inert, outside live document metadata and authority columns. */
export function transferDocumentMetadata(entry: KnowledgeTransferEntry) {
  return { knowledge_import: { key: entry.key, provenance: entry.provenance } };
}
export function transferLiveDigest(
  doc: {
    path: string;
    title: string;
    icon_emoji?: string | null;
    kind: string;
    status: string;
    visibility: string;
    edit_policy: string;
    metadata?: unknown;
  },
  version: { content_sha256?: string | null; frontmatter?: unknown }
) {
  return transferDigest({
    path: doc.path,
    title: doc.title,
    icon_emoji: doc.icon_emoji ?? null,
    kind: doc.kind,
    status: doc.status,
    visibility: doc.visibility,
    edit_policy: doc.edit_policy,
    metadata: doc.metadata ?? null,
    sha256: version.content_sha256 ?? null,
    frontmatter: version.frontmatter ?? null,
  });
}
export function transferEntryDigest(entry: KnowledgeTransferEntry) {
  return transferLiveDigest(
    {
      ...entry,
      visibility: 'private',
      edit_policy: 'owner',
      metadata: transferDocumentMetadata(entry),
    },
    { content_sha256: entry.sha256, frontmatter: entry.frontmatter }
  );
}
