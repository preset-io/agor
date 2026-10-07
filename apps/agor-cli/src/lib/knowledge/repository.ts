import {
  decodeKnowledgeDocument,
  importRepositoryLinks,
  parseKnowledgeYaml,
  repositoryTransferManifest,
  rewriteTransferLinks,
  transferDigest,
  transferSha256,
  validateRepositoryManifest,
  validateTransferManifest,
} from '@agor/core/knowledge';
import { KNOWLEDGE_REPOSITORY, KNOWLEDGE_TRANSFER } from '@agor/core/types';
import { RepositoryDirectory } from './repository-directory';

/** All local validation happens before the first daemon inventory request. */
export async function loadKnowledgeRepository(
  directory: RepositoryDirectory,
  targetSlug?: string,
  signal?: AbortSignal,
  onDocument?: (done: number, total: number) => void
) {
  const checkAbort = () => {
    if (signal?.aborted) throw new Error('Cancelled; completed destination work is retained');
  };
  checkAbort();
  await directory.assertComplete();
  const text = await directory.read(
    KNOWLEDGE_REPOSITORY.manifest,
    KNOWLEDGE_TRANSFER.maxManifestBytes
  );
  if (!text) {
    if (await directory.read('manifest.json', KNOWLEDGE_TRANSFER.maxManifestBytes))
      throw new Error(
        'Unsupported Knowledge export version 1. Export to a fresh directory with a CLI supporting repository format v2; the old bundle is unchanged'
      );
    throw new Error('Completed manifest.yaml is required');
  }
  const index = validateRepositoryManifest(parseKnowledgeYaml(text));
  const decoded = [];
  const raw = new Map<string, string>();
  const paths = new Map<string, string>();
  let bytes = 0;
  let metadataBytes = 0;
  onDocument?.(0, index.documents.length);
  for (const file of index.documents) {
    checkAbort();
    const content = await directory.read(file, KNOWLEDGE_REPOSITORY.maxFileBytes);
    if (content === null) throw new Error(`Missing indexed Knowledge document: ${file}`);
    let doc: ReturnType<typeof decodeKnowledgeDocument>;
    try {
      doc = decodeKnowledgeDocument(content);
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`);
    }
    bytes += Buffer.byteLength(doc.body);
    metadataBytes += Buffer.byteLength(content) - Buffer.byteLength(doc.body);
    if (
      bytes > KNOWLEDGE_TRANSFER.maxTotalBytes ||
      metadataBytes > KNOWLEDGE_TRANSFER.maxManifestBytes
    )
      throw new Error('Knowledge repository exceeds aggregate body/metadata limits');
    decoded.push(doc);
    raw.set(file, transferSha256(content));
    paths.set(file, doc.header.agor.path);
    onDocument?.(decoded.length, index.documents.length);
  }
  const source = validateTransferManifest(repositoryTransferManifest(index, decoded));
  const byId = new Map(
    decoded.map((doc, i) => [doc.header.agor.id, { ...doc, file: index.documents[i] }])
  );
  const contentByKey = new Map<string, string>();
  const fileByKey = new Map<string, string>();
  let unresolved = 0;
  for (const entry of source.documents) {
    const doc = byId.get(String(entry.provenance.source_uuid))!;
    const relative = importRepositoryLinks(
      doc.body,
      doc.file,
      paths,
      targetSlug ?? index.namespace.slug
    );
    const linked = rewriteTransferLinks(
      relative.content,
      source,
      targetSlug ?? index.namespace.slug
    );
    unresolved += relative.unresolved + linked.unresolved;
    entry.sha256 = transferSha256(linked.content);
    entry.bytes = Buffer.byteLength(linked.content);
    contentByKey.set(entry.key, linked.content);
    fileByKey.set(entry.key, doc.file);
  }
  const manifest = validateTransferManifest(source);
  const unlisted = (await directory.documentFiles()).filter((file) => !raw.has(file));
  return {
    manifest,
    contentByKey,
    unresolved,
    unlisted,
    async verify(key?: string) {
      checkAbort();
      await directory.assertComplete();
      const current = await directory.read(
        KNOWLEDGE_REPOSITORY.manifest,
        KNOWLEDGE_TRANSFER.maxManifestBytes
      );
      if (current !== text) throw new Error('Repository manifest changed after planning');
      const selected = key ? fileByKey.get(key) : undefined;
      if (key && !selected) throw new Error('Unknown planned document');
      const checks = selected ? [[selected, raw.get(selected)!]] : raw;
      for (const [file, hash] of checks) {
        checkAbort();
        const value = await directory.read(file, KNOWLEDGE_REPOSITORY.maxFileBytes);
        if (value === null || transferSha256(value) !== hash)
          throw new Error('Local file changed after planning');
      }
    },
  };
}

export async function validateKnowledgeRepository(path: string) {
  const directory = await RepositoryDirectory.open(path);
  try {
    const repo = await loadKnowledgeRepository(directory);
    await repo.verify();
    return {
      valid: true,
      version: 2,
      documents: repo.manifest.documents.length,
      bytes: repo.manifest.documents.reduce((n, d) => n + d.bytes, 0),
      bundle: transferDigest(repo.manifest),
      unresolved: repo.unresolved,
      unlisted: repo.unlisted,
    };
  } finally {
    await directory.close();
  }
}
