import {
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
import { loadKnowledgeRepository } from './repository';
import { RepositoryDirectory } from './repository-directory';
import { TransferFailures, TransferRequestError, transferRequest } from './transfer-errors';

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
function snapshotMetadata<T>(text: string, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(text));
  } catch {
    throw new Error(
      'Invalid local source-snapshot metadata; preserve it and use a fresh export directory'
    );
  }
}
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
  const cursors = new Set<string>();
  let ns: KnowledgeTransferPage['namespace'] = null;
  do {
    checkAbort(signal);
    progress.report('Planning: source inventory', entries.length);
    const page = await transferRequest(progress, 'Planning: source inventory', 'GET', () =>
      client.find({ query: { namespace, ...(cursor ? { cursor } : {}) } })
    );
    ns = page.namespace;
    entries.push(...page.entries);
    if (
      entries.length > KNOWLEDGE_TRANSFER.maxDocuments ||
      page.total > KNOWLEDGE_TRANSFER.maxDocuments
    )
      throw new Error('Namespace exceeds document limit');
    if (page.next_cursor && (cursors.has(page.next_cursor) || page.entries.length === 0))
      throw new Error('Invalid source inventory pagination; refusing to loop');
    cursor = page.next_cursor ?? undefined;
    if (cursor) cursors.add(cursor);
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
export async function exportSnapshot(
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
    const old = oldText ? snapshotMetadata(oldText, validateTransferManifest) : null;
    const checkpointText = await directory?.read(
      'checkpoint.json',
      KNOWLEDGE_TRANSFER.maxManifestBytes
    );
    const checkpoint = checkpointText
      ? snapshotMetadata(checkpointText, (value) => knowledgeTransferCheckpointSchema.parse(value))
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
    const failures = new TransferFailures();
    let totalBytes = 0;
    for (const row of source.entries) {
      checkAbort(options.signal);
      const key = keys[row.document_id];
      if (!/^d[0-9]{6}$/.test(key ?? '')) throw new Error('Invalid checkpoint key');
      const problem =
        !row.version_id || row.mime_type !== 'text/markdown'
          ? 'Unsupported or missing Markdown version'
          : row.bytes !== null && row.bytes > KNOWLEDGE_TRANSFER.maxDocumentBytes
            ? 'Document exceeds transfer byte limit'
            : undefined;
      if (problem) {
        failures.capture(
          new TransferRequestError(
            `Planning: source document — ${problem}. Check the source document before retrying.`,
            true
          ),
          key,
          progress,
          row.document_id
        );
        continue;
      }
      totalBytes += row.bytes ?? KNOWLEDGE_TRANSFER.maxDocumentBytes;
      if (totalBytes > KNOWLEDGE_TRANSFER.maxTotalBytes)
        throw new Error('Namespace exceeds transfer byte limit');
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
    if (options.dryRun) {
      failures.finish(
        `Export planning incomplete: ${plan.length} eligible documents`,
        'No export files were written. Resolve the source document errors before exporting a complete repository.'
      );
      return { dryRun: true, documents: plan.length, unchanged, pending, bytesNeeded, unknown };
    }
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
    const preflightFailures = failures.count;
    progress.report('Exporting', completed, pending);
    for (const action of plan) {
      checkAbort(options.signal);
      let sha256 = action.row.sha256;
      let length = action.row.bytes;
      if (!action.skip) {
        let body: Awaited<ReturnType<Client['get']>>;
        try {
          body = await transferRequest(
            progress,
            'Exporting document',
            'GET',
            () =>
              client.get(action.row.document_id, {
                query: { namespace: options.namespace, version: action.row.version_id },
              }),
            'document'
          );
          if (
            transferSha256(body.content) !== body.sha256 ||
            Buffer.byteLength(body.content, 'utf8') !== body.bytes ||
            (sha256 && sha256 !== body.sha256) ||
            (length !== null && length !== body.bytes)
          )
            throw new TransferRequestError(
              `Exporting document — GET /${KNOWLEDGE_TRANSFER.path}/:id: Source checksum mismatch; cached bytes were not accepted.`,
              true
            );
        } catch (error) {
          checkAbort(options.signal);
          failures.capture(error, action.key, progress, action.row.document_id);
          progress.report(
            'Exporting',
            completed + failures.count - preflightFailures,
            pending,
            `${completed} cached; ${failures.count} failed`
          );
          continue;
        }
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
          completed + failures.count - preflightFailures,
          pending,
          `${completed} cached; ${failures.count} failed; ${bytes} / ${bytesNeeded}${unknownBytes ? '+ (unknown sizes)' : ''} bytes`
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
    checkAbort(options.signal);
    failures.finish(
      `Export incomplete: ${completed} bodies cached; ${unchanged} unchanged`,
      'Verified source files and checkpoint are retained; no new completed manifest was published. Resolve the listed errors, then export the same source with --resume. If the source inventory changed, use a fresh output directory.'
    );
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
    progress.summary(
      `Source snapshot verified: ${completed} / ${pending} actions; ${unchanged} unchanged`
    );
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
  const directory = await RepositoryDirectory.open(options.directory);
  try {
    const repository = await loadKnowledgeRepository(
      directory,
      options.namespace,
      options.signal,
      (done, total) => progress.report('Planning: local files', done, total)
    );
    const manifest = repository.manifest;
    if (repository.unlisted.length)
      progress.summary(
        `${repository.unlisted.length} unlisted Markdown files are not imported; run agor kb validate to inspect.`
      );
    const bundle = transferDigest(manifest);
    const plan: Array<{
      entry: KnowledgeTransferEntry;
      skip: boolean;
      reconciled: boolean;
    }> = [];
    const unresolved = repository.unresolved;
    let totalRequestBytes = 0;
    for (const entry of manifest.documents) {
      checkAbort(options.signal);
      const content = repository.contentByKey.get(entry.key)!;
      const request = {
        action: 'document' as const,
        bundle,
        slug: options.namespace,
        entry,
        content,
      };
      const requestBytes = transferRequestBytes(request);
      if (requestBytes > KNOWLEDGE_TRANSFER.maxRequestBytes)
        throw new Error(`Encoded import request exceeds HTTP transfer limit: ${entry.path}`);
      totalRequestBytes += requestBytes;
      if (totalRequestBytes > KNOWLEDGE_TRANSFER.maxTotalRequestBytes)
        throw new Error('Encoded import plan exceeds namespace transfer limit');
      plan.push({ entry, skip: false, reconciled: false });
      progress.report('Planning: local checksums', plan.length, manifest.documents.length);
    }
    let cursor: string | undefined;
    let exists = false;
    let scanned = 0;
    progress.report('Planning: destination inventory', 0);
    const planned = new Map(plan.map((action) => [action.entry.key, action]));
    const cursors = new Set<string>();
    do {
      checkAbort(options.signal);
      const page = await transferRequest(progress, 'Planning: destination inventory', 'GET', () =>
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
      if (page.next_cursor && (cursors.has(page.next_cursor) || page.receipts.length === 0))
        throw new Error('Invalid destination inventory pagination; refusing to loop');
      cursor = page.next_cursor ?? undefined;
      if (cursor) cursors.add(cursor);
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
    if (options.dryRun) {
      await repository.verify();
      return { dryRun: true, documents: plan.length, unchanged, pending, bytesNeeded, unresolved };
    }
    checkAbort(options.signal);
    await repository.verify();
    await transferRequest(progress, 'Creating import namespace', 'POST', () =>
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
    const failures = new TransferFailures();
    progress.report('Importing', completed, pending);
    for (const action of plan) {
      checkAbort(options.signal);
      if (action.skip) continue;
      await repository.verify(action.entry.key);
      const content = repository.contentByKey.get(action.entry.key)!;
      if (transferSha256(content) !== action.entry.sha256) throw new Error('Import plan changed');
      try {
        await transferRequest(progress, 'Importing document', 'POST', () =>
          client.create({
            action: 'document',
            bundle,
            slug: options.namespace,
            entry: action.entry,
            content,
          })
        );
      } catch (error) {
        checkAbort(options.signal);
        failures.capture(error, action.entry.key, progress, action.entry.provenance.source_uuid);
        progress.report(
          'Importing',
          completed + failures.count,
          pending,
          `${completed} acknowledged; ${failures.count} failed or unconfirmed`
        );
        continue;
      }
      completed++;
      bytes += action.entry.bytes;
      progress.report(
        'Importing',
        completed + failures.count,
        pending,
        `${completed} acknowledged; ${failures.count} failed or unconfirmed; ${bytes} / ${bytesNeeded} bytes`
      );
    }
    checkAbort(options.signal);
    failures.finish(
      `Import incomplete: ${completed} creates acknowledged; ${unchanged} unchanged`,
      'Committed documents and server receipts are retained. Unconfirmed writes may have committed. Reference reconciliation is deferred until every document is available. Resolve the errors, then check the unchanged bundle with --resume --dry-run before --resume --apply; no documents are overwritten.'
    );
    let reconciled = 0;
    const references = pending > 0 ? plan : plan.filter((action) => !action.reconciled);
    progress.report('Reconciling references', 0, references.length);
    for (const action of references) {
      checkAbort(options.signal);
      try {
        await transferRequest(progress, 'Reconciling references', 'POST', () =>
          client.create({
            action: 'reconcile',
            bundle,
            slug: options.namespace,
            key: action.entry.key,
          })
        );
      } catch (error) {
        checkAbort(options.signal);
        failures.capture(error, action.entry.key, progress, action.entry.provenance.source_uuid);
        progress.report(
          'Reconciling references',
          reconciled + failures.count,
          references.length,
          `${failures.count} failed or unconfirmed`
        );
        continue;
      }
      progress.report('Reconciling references', ++reconciled + failures.count, references.length);
    }
    checkAbort(options.signal);
    failures.finish(
      `Import documents retained; ${reconciled} / ${references.length} reference checks acknowledged`,
      'Resolve the errors, then check --resume --dry-run before --resume --apply. Server receipts skip completed documents and reference checks.'
    );
    progress.summary(
      `Complete: ${completed} / ${pending} creates; ${unchanged} unchanged; ${reconciled} / ${references.length} references checked. Namespace is private; indexing is asynchronous.`
    );
    return { documents: plan.length, created: completed, unchanged, bytes, unresolved };
  } finally {
    await directory.close();
  }
}
