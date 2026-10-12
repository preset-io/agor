import {
  decodeKnowledgeDocument,
  encodeKnowledgeDocument,
  exportRepositoryLinks,
  knowledgeRepositoryFiles,
  parseKnowledgeYaml,
  portableKnowledgeFile,
  serializeKnowledgeYaml,
  transferCanonical,
  transferSha256,
  validateRepositoryManifest,
  validateTransferManifest,
} from '@agor/core/knowledge';
import {
  KNOWLEDGE_REPOSITORY,
  KNOWLEDGE_TRANSFER,
  type KnowledgeRepositoryBaseline,
  type KnowledgeRepositoryPublication,
  knowledgeRepositoryBaselineSchema,
  knowledgeRepositoryPublicationSchema,
} from '@agor/core/types';
import { KnowledgeDirectory } from './directory';
import type { KnowledgeProgress } from './progress';
import { RepositoryDirectory } from './repository-directory';
import { exportSnapshot, type knowledgeTransferClient, type TransferOptions } from './transfer';

const baselinePath = KNOWLEDGE_REPOSITORY.baseline;
const pendingPath = KNOWLEDGE_REPOSITORY.pending;
const limit = KNOWLEDGE_REPOSITORY.maxFileBytes;
const hash = (text: string | null) => (text === null ? null : transferSha256(text));
const allowed = (file: string) =>
  file === KNOWLEDGE_REPOSITORY.manifest ? file : portableKnowledgeFile(file);
const parseState = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid local export state; preserve it and use a fresh directory');
  }
};
const abort = (signal: AbortSignal) => {
  if (signal.aborted) throw new Error('Cancelled; resume export to finish publication');
};

/** Recover only a preflighted, journaled publication. Never overwrite intervening edits. */
export async function publishKnowledgeRepository(
  directory: RepositoryDirectory,
  publication: KnowledgeRepositoryPublication,
  signal: AbortSignal
) {
  const parsed = knowledgeRepositoryPublicationSchema.safeParse(publication);
  if (!parsed.success) throw new Error('Invalid export publication journal');
  const plan = parsed.data;
  if (Object.keys(plan.next.files).length > KNOWLEDGE_TRANSFER.maxDocuments + 1)
    throw new Error('Export baseline exceeds limit');
  for (const file of Object.keys(plan.next.files)) allowed(file);
  const seen = new Set<string>();
  for (const write of plan.writes) {
    allowed(write.file);
    if (seen.has(write.file) || plan.next.files[write.file] !== write.after)
      throw new Error('Invalid export publication journal');
    seen.add(write.file);
    if (
      hash(await directory.read(`${KNOWLEDGE_REPOSITORY.stage}/${write.file}`, limit)) !==
      write.after
    )
      throw new Error('Export staging is incomplete or corrupt; preserve the directory');
    const current = hash(await directory.read(write.file, limit));
    if (current !== write.before && current !== write.after)
      throw new Error('Local content differs from export baseline; refusing overwrite');
  }
  // Files then manifest; the durable pending marker blocks imports across crashes.
  for (const write of [...plan.writes].sort(
    (a, b) =>
      Number(a.file === KNOWLEDGE_REPOSITORY.manifest) -
      Number(b.file === KNOWLEDGE_REPOSITORY.manifest)
  )) {
    abort(signal);
    const current = hash(await directory.read(write.file, limit));
    if (current === write.after) continue;
    if (current !== write.before)
      throw new Error('Local content changed during export publication');
    const content = await directory.read(`${KNOWLEDGE_REPOSITORY.stage}/${write.file}`, limit);
    if (hash(content) !== write.after) throw new Error('Export staging changed');
    await directory.write(write.file, content!, write.before);
  }
  for (const [file, expected] of Object.entries(plan.next.files)) {
    if (hash(await directory.read(file, limit)) !== expected)
      throw new Error('Published export changed before completion');
  }
  await directory.write(baselinePath, transferCanonical(plan.next));
  await directory.write(pendingPath, 'null');
}

export async function exportKnowledge(
  client: ReturnType<typeof knowledgeTransferClient>,
  options: TransferOptions,
  progress: KnowledgeProgress
) {
  abort(options.signal);
  let directory: RepositoryDirectory;
  try {
    directory = await RepositoryDirectory.open(options.directory, !options.dryRun);
  } catch (error) {
    if (options.dryRun && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return exportSnapshot(
        client,
        {
          ...options,
          directory: `${options.directory}/${KNOWLEDGE_REPOSITORY.state}/${KNOWLEDGE_REPOSITORY.snapshot}`,
        },
        progress
      );
    throw error;
  }
  try {
    if (await directory.read('manifest.json', KNOWLEDGE_TRANSFER.maxManifestBytes))
      throw new Error(
        'Version 1 export directory is immutable; choose a fresh directory for version 2'
      );
    if (options.dryRun) await directory.assertComplete();
    else await directory.lock();
    const pending = await directory.read(pendingPath, KNOWLEDGE_TRANSFER.maxManifestBytes);
    if (pending && parseState(pending) !== null) {
      if (options.dryRun || !options.resume)
        throw new Error('Export publication incomplete; rerun export with --resume');
      const checked = knowledgeRepositoryPublicationSchema.safeParse(parseState(pending));
      if (!checked.success) throw new Error('Invalid export publication journal');
      const publication = checked.data;
      if (publication.sourceIdentity !== options.sourceIdentity)
        throw new Error('Export publication belongs to another deployment/user');
      await publishKnowledgeRepository(directory, publication, options.signal);
    }
    const baselineText = await directory.read(baselinePath, KNOWLEDGE_TRANSFER.maxManifestBytes);
    const checkedBaseline = knowledgeRepositoryBaselineSchema.safeParse(
      baselineText ? parseState(baselineText) : { version: 2, files: {} }
    );
    if (!checkedBaseline.success) throw new Error('Invalid local export baseline');
    const baseline: KnowledgeRepositoryBaseline = checkedBaseline.data;
    if (Object.keys(baseline.files).length > KNOWLEDGE_TRANSFER.maxDocuments + 1)
      throw new Error('Export baseline exceeds limit');
    for (const [file, expected] of Object.entries(baseline.files)) {
      allowed(file);
      if (hash(await directory.read(file, limit)) !== expected)
        throw new Error(
          'Local content differs from export baseline; use a fresh directory or preserve/reconcile your edits'
        );
    }
    const prior = await directory.read(
      KNOWLEDGE_REPOSITORY.manifest,
      KNOWLEDGE_TRANSFER.maxManifestBytes
    );
    const previous = new Map<string, string>();
    if (prior) {
      const oldIndex = validateRepositoryManifest(parseKnowledgeYaml(prior));
      for (const file of oldIndex.documents) {
        const text = await directory.read(file, limit);
        if (text === null) throw new Error('Missing previously exported document');
        previous.set(decodeKnowledgeDocument(text).header.agor.path, file);
      }
      if (!baselineText)
        throw new Error(
          'No local export baseline; use a fresh output directory (Git clones remain importable)'
        );
    }
    if (options.dryRun)
      return exportSnapshot(
        client,
        {
          ...options,
          directory: `${directory.path}/${KNOWLEDGE_REPOSITORY.state}/${KNOWLEDGE_REPOSITORY.snapshot}`,
        },
        progress
      );
    // Metadata/output permissions are checked before any source requests. Do not
    // modify a caller's existing Git control files.
    for (const [name, contents] of [
      ['.gitignore', '.agor/\n.agor-lock/\n'],
      ['.gitattributes', 'docs/**/*.md -text\nmanifest.yaml text eol=lf\n'],
    ]) {
      if ((await directory.read(name, KNOWLEDGE_TRANSFER.maxManifestBytes)) === null)
        await directory.write(name, contents);
      else
        progress.summary(
          `Existing ${name} retained; ensure local .agor state is ignored and Markdown bytes are not converted.`
        );
    }
    return await directory.withDirectory(KNOWLEDGE_REPOSITORY.state, true, async (stateRoot) => {
      const snapshotPath = `${stateRoot}/${KNOWLEDGE_REPOSITORY.snapshot}`;
      const result = await exportSnapshot(
        client,
        { ...options, directory: snapshotPath },
        progress
      );
      const snapshot = await KnowledgeDirectory.open(snapshotPath);
      try {
        const manifest = validateTransferManifest(
          JSON.parse((await snapshot.read('manifest.json', KNOWLEDGE_TRANSFER.maxManifestBytes))!)
        );
        const files = knowledgeRepositoryFiles(
          manifest.documents.map((doc) => doc.path),
          previous
        );
        const index = validateRepositoryManifest({
          format: manifest.format,
          version: 2,
          namespace: manifest.namespace,
          documents: [...files.values()].sort(),
          omissions: manifest.omissions,
        });
        const publication: KnowledgeRepositoryPublication = {
          version: 2,
          sourceIdentity: options.sourceIdentity,
          writes: [],
          next: { version: 2, files: {} },
        };
        let unresolved = 0;
        let bodyBytes = 0;
        let metadataBytes = 0;
        const stage = async (file: string, content: string) => {
          abort(options.signal);
          const after = transferSha256(content);
          const before = hash(await directory.read(file, limit));
          if (before !== (baseline.files[file] ?? null))
            throw new Error(
              'Export target contains untracked or edited content; refusing overwrite'
            );
          publication.next.files[file] = after;
          if (before === after) return;
          await directory.write(`${KNOWLEDGE_REPOSITORY.stage}/${file}`, content);
          publication.writes.push({ file, before, after });
        };
        for (const doc of manifest.documents) {
          const file = files.get(doc.path)!;
          const body = await snapshot.read(
            `${doc.key}-${doc.sha256}.md`,
            KNOWLEDGE_TRANSFER.maxDocumentBytes
          );
          if (body === null || transferSha256(body) !== doc.sha256)
            throw new Error('Export snapshot checksum mismatch');
          const links = exportRepositoryLinks(body, manifest, files, file);
          unresolved += links.unresolved;
          const {
            key: _key,
            sha256: _sha,
            bytes: _bytes,
            frontmatter,
            provenance,
            ...attributes
          } = doc;
          const encoded = encodeKnowledgeDocument(
            {
              format: KNOWLEDGE_REPOSITORY.documentFormat,
              version: 2,
              agor: { id: String(provenance.source_uuid), ...attributes },
              frontmatter,
              provenance,
            },
            links.content
          );
          bodyBytes += Buffer.byteLength(links.content);
          metadataBytes += Buffer.byteLength(encoded) - Buffer.byteLength(links.content);
          if (
            Buffer.byteLength(links.content) > KNOWLEDGE_TRANSFER.maxDocumentBytes ||
            bodyBytes > KNOWLEDGE_TRANSFER.maxTotalBytes ||
            metadataBytes > KNOWLEDGE_TRANSFER.maxManifestBytes
          )
            throw new Error('Repository exceeds serialized body/metadata limits');
          await stage(file, encoded);
        }
        await stage(KNOWLEDGE_REPOSITORY.manifest, serializeKnowledgeYaml(index));
        const journal = transferCanonical(publication);
        if (Buffer.byteLength(journal) > KNOWLEDGE_TRANSFER.maxManifestBytes)
          throw new Error('Export publication journal exceeds limit');
        await directory.write(pendingPath, journal);
        await publishKnowledgeRepository(directory, publication, options.signal);
        const retained = Object.keys(baseline.files).filter(
          (file) => !Object.hasOwn(publication.next.files, file)
        );
        progress.summary(
          `Repository complete: ${index.documents.length} documents; ${unresolved} unresolved links; ${retained.length} old files retained, not imported.`
        );
        return {
          ...result,
          manifest: `${options.directory}/${KNOWLEDGE_REPOSITORY.manifest}`,
          unresolved,
          retained,
        };
      } finally {
        await snapshot.close();
      }
    });
  } finally {
    await directory.close();
  }
}
