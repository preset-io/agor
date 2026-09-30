import {
  rewriteTransferLinks,
  serializeTransferManifest,
  transferDigest,
  transferEntryDigest,
  transferRequestBytes,
  transferSha256,
  validateTransferManifest,
} from '@agor/core/knowledge';
import {
  KNOWLEDGE_TRANSFER,
  type KnowledgeTransferEntry,
  type KnowledgeTransferInventoryEntry,
  type KnowledgeTransferPage,
  knowledgeTransferCheckpointSchema,
} from '@agor/core/types';
import type { AuthenticatedAgorClient } from '@agor-live/client';
import { KnowledgeDirectory } from './directory';
import type { KnowledgeProgress } from './progress';

// Canonical SDK overload, kept separate from the generic service fallback.
export function knowledgeTransferClient(client: AuthenticatedAgorClient) {
  return client.service(KNOWLEDGE_TRANSFER.path);
}
type Client = ReturnType<typeof knowledgeTransferClient>;
export interface TransferOptions {
  namespace: string;
  directory: string;
  dryRun: boolean;
  resume: boolean;
  sourceIdentity: string;
  signal: AbortSignal;
}
function checkAbort(signal: AbortSignal) {
  if (signal.aborted)
    throw new Error('Cancelled; completed work is retained. Re-run with --resume');
}
const filename = (key: string, sha256: string) => `${key}-${sha256}.md`;
const omissions = [
  'history',
  'archived documents',
  'ACLs',
  'explicit graph',
  'asset bytes',
  'authoritative source attribution',
];

async function inventory(
  client: Client,
  namespace: string,
  progress: KnowledgeProgress,
  signal: AbortSignal
) {
  const entries: KnowledgeTransferInventoryEntry[] = [];
  let cursor: string | undefined;
  let ns: KnowledgeTransferPage['namespace'] = null;
  do {
    checkAbort(signal);
    progress.report('Planning: source inventory', entries.length);
    const page = await progress.waiting(() =>
      client.find({ query: { namespace, ...(cursor ? { cursor } : {}) } })
    );
    ns = page.namespace;
    entries.push(...page.entries);
    if (
      entries.length > KNOWLEDGE_TRANSFER.maxDocuments ||
      page.total > KNOWLEDGE_TRANSFER.maxDocuments
    )
      throw new Error('Namespace exceeds document limit');
    if (page.next_cursor && page.next_cursor === cursor)
      throw new Error('Inventory cursor did not advance');
    cursor = page.next_cursor ?? undefined;
    progress.report(
      'Planning: source inventory',
      entries.length,
      page.total,
      '(current authorized count; rechecked before completion)'
    );
  } while (cursor);
  if (!ns) throw new Error('Namespace not found');
  return { namespace: ns, entries };
}

/** Hash remote headers and local bytes first; fetch only planned bodies. */
export async function exportKnowledge(
  client: Client,
  options: TransferOptions,
  progress: KnowledgeProgress
) {
  // Validate the local directory before any remote work so local problems fail fast.
  let directory: KnowledgeDirectory | undefined;
  try {
    directory = await KnowledgeDirectory.open(options.directory, !options.dryRun);
  } catch (error) {
    if (!options.dryRun || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    const source = await inventory(client, options.namespace, progress, options.signal);
    const fingerprint = transferDigest({ sourceIdentity: options.sourceIdentity, ...source });
    if (!options.dryRun) await directory!.lock();
    const oldText = await directory?.read('manifest.json', KNOWLEDGE_TRANSFER.maxManifestBytes);
    const old = oldText ? validateTransferManifest(JSON.parse(oldText)) : null;
    const checkpointText = await directory?.read(
      'checkpoint.json',
      KNOWLEDGE_TRANSFER.maxManifestBytes
    );
    const checkpoint = checkpointText
      ? knowledgeTransferCheckpointSchema.parse(JSON.parse(checkpointText))
      : null;
    if (checkpoint && checkpoint.sourceIdentity !== options.sourceIdentity)
      throw new Error('Export directory belongs to another deployment/user');
    if (
      old &&
      (old.namespace.slug !== source.namespace.slug ||
        old.namespace.provenance.source_uuid !== source.namespace.provenance.source_uuid)
    )
      throw new Error('Export directory belongs to another namespace');
    if (checkpoint && checkpoint.fingerprint !== fingerprint && !old)
      throw new Error(
        'Source changed since the incomplete export plan. Use a new output directory; no local files were overwritten'
      );
    if (checkpoint && !old && !options.resume)
      throw new Error('Incomplete export exists; use --resume');
    const samePlan = checkpoint?.fingerprint === fingerprint;
    const oldById = new Map(old?.documents.map((doc) => [doc.provenance.source_uuid, doc]) ?? []);
    let nextKey =
      checkpoint?.nextKey ??
      Math.max(0, ...Object.values(checkpoint?.keys ?? {}).map((key) => Number(key.slice(1))));
    if (!Number.isSafeInteger(nextKey) || nextKey < 0 || nextKey > 999999)
      throw new Error('Invalid export checkpoint');
    const keys: Record<string, string> = {};
    for (const row of source.entries)
      keys[row.document_id] = samePlan
        ? checkpoint!.keys![row.document_id]
        : (oldById.get(row.document_id)?.key ?? `d${String(++nextKey).padStart(6, '0')}`);
    const plan: Array<{
      row: KnowledgeTransferInventoryEntry;
      key: string;
      skip: boolean;
    }> = [];
    let totalBytes = 0;
    for (const row of source.entries) {
      checkAbort(options.signal);
      if (!row.version_id || row.mime_type !== 'text/markdown')
        throw new Error(`Unsupported or missing content: ${row.path}`);
      if (row.bytes !== null && row.bytes > KNOWLEDGE_TRANSFER.maxDocumentBytes)
        throw new Error(`Document too large: ${row.path}`);
      totalBytes += row.bytes ?? KNOWLEDGE_TRANSFER.maxDocumentBytes;
      if (totalBytes > KNOWLEDGE_TRANSFER.maxTotalBytes)
        throw new Error('Namespace exceeds transfer byte limit');
      const key = keys[row.document_id];
      if (!/^d[0-9]{6}$/.test(key ?? '')) throw new Error('Invalid checkpoint key');
      const local =
        (await directory?.read(
          filename(key, row.sha256 ?? oldById.get(row.document_id)?.sha256 ?? '0'.repeat(64)),
          KNOWLEDGE_TRANSFER.maxDocumentBytes
        )) ?? null;
      const skip = local !== null && row.sha256 !== null && transferSha256(local) === row.sha256;
      if (local !== null && !skip && row.sha256 !== null)
        throw new Error(`Local content differs from source: ${row.path}; use a fresh directory`);
      plan.push({ row, key, skip });
      progress.report('Planning: local checksums', plan.length, source.entries.length);
    }
    const unchanged = plan.filter((entry) => entry.skip).length;
    const pending = plan.length - unchanged;
    const bytesNeeded = plan
      .filter((entry) => !entry.skip)
      .reduce((n, entry) => n + (entry.row.bytes ?? 0), 0);
    const unknown = plan.filter((entry) => !entry.row.sha256).length;
    const unknownBytes = plan.filter((entry) => !entry.skip && entry.row.bytes === null).length;
    progress.summary(
      `Plan: ${plan.length} documents; ${unchanged} unchanged; ${pending} fetch/verify; ${bytesNeeded} known bytes; ${unknown} unknown hashes`
    );
    if (options.dryRun)
      return { dryRun: true, documents: plan.length, unchanged, pending, bytesNeeded, unknown };
    const exported_at =
      (samePlan ? checkpoint?.exported_at : undefined) ?? new Date().toISOString();
    await directory!.write(
      'checkpoint.json',
      JSON.stringify({
        fingerprint,
        sourceIdentity: options.sourceIdentity,
        keys,
        nextKey,
        exported_at,
      })
    );
    const documents: KnowledgeTransferEntry[] = [];
    let completed = 0;
    let bytes = 0;
    progress.report('Exporting', completed, pending);
    for (const action of plan) {
      checkAbort(options.signal);
      let sha256 = action.row.sha256;
      let length = action.row.bytes;
      if (!action.skip) {
        const body = await progress.waiting(() =>
          client.get(action.row.document_id, {
            query: { namespace: options.namespace, version: action.row.version_id },
          })
        );
        if (
          transferSha256(body.content) !== body.sha256 ||
          Buffer.byteLength(body.content, 'utf8') !== body.bytes ||
          (sha256 && sha256 !== body.sha256) ||
          (length !== null && length !== body.bytes)
        )
          throw new Error('Source checksum mismatch');
        // Content-addressed files are immutable: source refresh never overwrites local bytes.
        const existing = await directory!.read(
          filename(action.key, body.sha256),
          KNOWLEDGE_TRANSFER.maxDocumentBytes
        );
        if (existing !== null && transferSha256(existing) !== body.sha256)
          throw new Error('Local content-addressed file is corrupt');
        if (existing === null)
          await directory!.write(filename(action.key, body.sha256), body.content);
        sha256 = body.sha256;
        length = body.bytes;
        completed++;
        bytes += body.bytes;
        progress.report(
          'Exporting',
          completed,
          pending,
          `${bytes} / ${bytesNeeded}${unknownBytes ? '+ (unknown sizes)' : ''} bytes`
        );
      }
      if (length === null)
        length = Buffer.byteLength(
          (await directory!.read(
            filename(action.key, sha256!),
            KNOWLEDGE_TRANSFER.maxDocumentBytes
          ))!,
          'utf8'
        );
      documents.push({
        key: action.key,
        path: action.row.path,
        title: action.row.title,
        icon_emoji: action.row.icon_emoji,
        kind: action.row.kind,
        status: action.row.status,
        sha256: sha256!,
        bytes: length,
        frontmatter: action.row.frontmatter,
        provenance: action.row.provenance,
      });
    }
    progress.summary('Verifying source inventory (not a point-in-time snapshot)…');
    const final = await inventory(client, options.namespace, progress, options.signal);
    if (transferDigest({ sourceIdentity: options.sourceIdentity, ...final }) !== fingerprint)
      throw new Error('Source changed during export; no new completed manifest was published');
    const manifest = validateTransferManifest({
      format: KNOWLEDGE_TRANSFER.format,
      version: 1,
      completed: true,
      consistency: 'per-document-version; non-atomic-inventory',
      exported_at,
      namespace: source.namespace,
      documents,
      omissions,
    });
    // Revalidate all local bytes before publishing completion, including skipped files.
    let verified = 0;
    progress.report('Verifying local files', 0, documents.length);
    for (const doc of documents) {
      checkAbort(options.signal);
      const content = await directory!.read(
        filename(doc.key, doc.sha256),
        KNOWLEDGE_TRANSFER.maxDocumentBytes
      );
      if (content === null || transferSha256(content) !== doc.sha256)
        throw new Error('Local content changed during export');
      progress.report('Verifying local files', ++verified, documents.length);
    }
    checkAbort(options.signal);
    await directory!.write('manifest.json', serializeTransferManifest(manifest));
    progress.summary(`Complete: ${completed} / ${pending} actions; ${unchanged} unchanged`);
    return {
      documents: documents.length,
      copied: completed,
      unchanged,
      bytes,
      manifest: `${options.directory}/manifest.json`,
    };
  } finally {
    await directory?.close();
  }
}

export async function importKnowledge(
  client: Client,
  options: TransferOptions,
  progress: KnowledgeProgress
) {
  const directory = await KnowledgeDirectory.open(options.directory);
  try {
    if (await directory.hasLock())
      throw new Error('Export is still locked; do not import an active export');
    const text = await directory.read('manifest.json', KNOWLEDGE_TRANSFER.maxManifestBytes);
    if (!text) throw new Error('Completed manifest.json is required');
    const manifest = validateTransferManifest(JSON.parse(text));
    const bundle = transferDigest(manifest);
    const plan: Array<{
      entry: KnowledgeTransferEntry;
      sourceHash: string;
      skip: boolean;
      reconciled: boolean;
    }> = [];
    let unresolved = 0;
    let totalRequestBytes = 0;
    for (const entry of manifest.documents) {
      checkAbort(options.signal);
      const original = await directory.read(
        filename(entry.key, entry.sha256),
        KNOWLEDGE_TRANSFER.maxDocumentBytes
      );
      if (
        original === null ||
        transferSha256(original) !== entry.sha256 ||
        Buffer.byteLength(original, 'utf8') !== entry.bytes
      )
        throw new Error(`Checksum mismatch: ${entry.path}`);
      const rewritten = rewriteTransferLinks(original, manifest, options.namespace);
      const request = {
        action: 'document' as const,
        bundle,
        slug: options.namespace,
        entry: {
          ...entry,
          sha256: transferSha256(rewritten.content),
          bytes: Buffer.byteLength(rewritten.content, 'utf8'),
        },
        content: rewritten.content,
      };
      const requestBytes = transferRequestBytes(request);
      if (requestBytes > KNOWLEDGE_TRANSFER.maxRequestBytes)
        throw new Error(`Encoded import request exceeds HTTP transfer limit: ${entry.path}`);
      totalRequestBytes += requestBytes;
      if (totalRequestBytes > KNOWLEDGE_TRANSFER.maxTotalRequestBytes)
        throw new Error('Encoded import plan exceeds namespace transfer limit');
      unresolved += rewritten.unresolved;
      plan.push({
        entry: {
          ...entry,
          sha256: transferSha256(rewritten.content),
          bytes: Buffer.byteLength(rewritten.content, 'utf8'),
        },
        sourceHash: entry.sha256,
        skip: false,
        reconciled: false,
      });
      progress.report('Planning: local checksums', plan.length, manifest.documents.length);
    }
    let cursor: string | undefined;
    let exists = false;
    let scanned = 0;
    progress.report('Planning: destination inventory', 0);
    const planned = new Map(plan.map((action) => [action.entry.key, action]));
    do {
      checkAbort(options.signal);
      const page = await progress.waiting(() =>
        client.find({
          query: { namespace: options.namespace, bundle, ...(cursor ? { cursor } : {}) },
        })
      );
      exists = Boolean(page.namespace);
      scanned += page.receipts.length;
      progress.report('Planning: destination inventory', scanned, page.total);
      for (const receipt of page.receipts) {
        const action = planned.get(receipt.key);
        if (!action || !receipt.unchanged || receipt.digest !== transferEntryDigest(action.entry))
          throw new Error(`Destination conflict: ${receipt.key}`);
        action.skip = true;
        action.reconciled = receipt.reconciled;
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    if (exists && !options.resume) throw new Error('Destination import exists; use --resume');
    const unchanged = plan.filter((action) => action.skip).length;
    const pending = plan.length - unchanged;
    const bytesNeeded = plan
      .filter((action) => !action.skip)
      .reduce((n, action) => n + action.entry.bytes, 0);
    progress.summary(
      `Plan: ${plan.length} documents; ${unchanged} unchanged; ${pending} create; ${bytesNeeded} bytes; ${unresolved} unresolved KB links. History, assets and ACLs are excluded.`
    );
    if (options.dryRun)
      return { dryRun: true, documents: plan.length, unchanged, pending, bytesNeeded, unresolved };
    checkAbort(options.signal);
    await progress.waiting(() =>
      client.create({
        action: 'namespace',
        bundle,
        slug: options.namespace,
        display_name: manifest.namespace.display_name,
        description: manifest.namespace.description,
        resume: options.resume,
      })
    );
    let completed = 0;
    let bytes = 0;
    progress.report('Importing', completed, pending);
    for (const action of plan) {
      checkAbort(options.signal);
      if (action.skip) continue;
      const original = await directory.read(
        filename(action.entry.key, action.sourceHash),
        KNOWLEDGE_TRANSFER.maxDocumentBytes
      );
      if (original === null || transferSha256(original) !== action.sourceHash)
        throw new Error('Local file changed after planning');
      const { content } = rewriteTransferLinks(original, manifest, options.namespace);
      if (transferSha256(content) !== action.entry.sha256) throw new Error('Import plan changed');
      await progress.waiting(() =>
        client.create({
          action: 'document',
          bundle,
          slug: options.namespace,
          entry: action.entry,
          content,
        })
      );
      completed++;
      bytes += action.entry.bytes;
      progress.report('Importing', completed, pending, `${bytes} / ${bytesNeeded} bytes`);
    }
    let reconciled = 0;
    const references = pending > 0 ? plan : plan.filter((action) => !action.reconciled);
    progress.report('Reconciling references', 0, references.length);
    for (const action of references) {
      checkAbort(options.signal);
      await progress.waiting(() =>
        client.create({
          action: 'reconcile',
          bundle,
          slug: options.namespace,
          key: action.entry.key,
        })
      );
      progress.report('Reconciling references', ++reconciled, references.length);
    }
    progress.summary(
      `Complete: ${completed} / ${pending} creates; ${unchanged} unchanged; ${reconciled} / ${references.length} references checked. Namespace is private; indexing is asynchronous.`
    );
    return { documents: plan.length, created: completed, unchanged, bytes, unresolved };
  } finally {
    await directory.close();
  }
}
