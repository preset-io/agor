import {
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  KnowledgeNamespaceRepository,
  KnowledgeSemanticSettingsRepository,
  KnowledgeTransferRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, Conflict, Forbidden, NotFound } from '@agor/core/feathers';
import {
  completedTransferManifest,
  decodeKnowledgeRepositoryFile,
  knowledgeRepositoryWriter,
  knowledgeTransferValidationIssues,
  knowledgeTransferValidationSummary,
  outsideKnowledgeLinks,
  parseKnowledgeYaml,
  planKnowledgeRepositoryImport,
  transferDigest,
  transferDocumentMetadata,
  transferEntryDigest,
  transferInventoryEntry,
  transferRequestBytes,
  transferSha256,
  validateRepositoryManifest,
} from '@agor/core/knowledge';
import type {
  AgorPackAuthor,
  AgorPackKnowledgeHistory,
  AgorPackOutsideLinks,
  AuthenticatedParams,
  KnowledgeTransferBody,
  KnowledgeTransferEntry,
  KnowledgeTransferInventoryEntry,
  KnowledgeTransferPage,
  KnowledgeTransferWriteResult,
  User,
  UserID,
} from '@agor/core/types';
import {
  hasMinimumRole,
  KNOWLEDGE_REPOSITORY,
  KNOWLEDGE_TRANSFER,
  knowledgeTransferHash,
  knowledgeTransferSlug,
  knowledgeTransferWriteSchema,
  ROLES,
} from '@agor/core/types';
import { z } from 'zod';
import { runKnowledgePolicyTransaction } from '../knowledge/policy-transaction.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { canReadKnowledgeDocument, isKnowledgeAdmin } from './knowledge-access.js';
import { KnowledgeDocumentsService } from './knowledge-documents.js';

function parseTransfer<T>(
  schema: z.ZodType<T>,
  input: unknown,
  method: 'GET' | 'POST',
  route: 'collection' | 'document' = 'collection'
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = knowledgeTransferValidationIssues(result.error.issues);
    throw new BadRequest(
      `Invalid Knowledge transfer request (${method} /${KNOWLEDGE_TRANSFER.path}${route === 'document' ? '/:id' : ''}): ${knowledgeTransferValidationSummary(issues)}`,
      {
        issues,
      }
    );
  }
  return result.data;
}

const querySchema = z
  .object({
    namespace: knowledgeTransferSlug,
    cursor: z.string().max(100).optional(),
    bundle: knowledgeTransferHash.optional(),
  })
  .strict();
type TransferParams = AuthenticatedParams & { query?: Record<string, unknown> };

type KnowledgeNamespaceRow = NonNullable<
  Awaited<ReturnType<KnowledgeNamespaceRepository['findBySlug']>>
>;

function knowledgeNamespaceProjection(ns: KnowledgeNamespaceRow) {
  return {
    slug: ns.slug,
    display_name: ns.display_name,
    description: ns.description ?? null,
    provenance: JSON.parse(
      JSON.stringify({
        source_uuid: ns.namespace_id,
        kind: ns.kind,
        owner_user_id: ns.owner_user_id,
        created_by: ns.created_by,
        visibility_default: ns.visibility_default,
        others_can: ns.others_can,
        repo_id: ns.repo_id,
        branch_id: ns.branch_id,
        created_at: ns.created_at,
        updated_at: ns.updated_at,
        metadata: ns.metadata ?? null,
      })
    ),
  };
}

/** One request is one bounded DB unit. No local files, jobs or source-supplied identities. */
export class KnowledgeTransfersService {
  constructor(
    private db: TenantScopeAwareDatabase,
    private app?: Application
  ) {}
  private user(params?: TransferParams): User {
    const user = params?.user as User | undefined;
    if (!user || !hasMinimumRole(user.role, ROLES.MEMBER))
      throw new Forbidden('Knowledge transfer requires member access');
    return user;
  }
  private async source(slug: string, user: User) {
    if (!isKnowledgeAdmin(user))
      throw new Forbidden('Complete namespace export requires a workspace admin');
    const namespace = await new KnowledgeNamespaceRepository(this.db).findBySlug(slug);
    if (!namespace || namespace.archived) throw new NotFound('Knowledge namespace not found');
    return namespace;
  }
  private namespaceProjection(ns: Awaited<ReturnType<KnowledgeNamespaceRepository['findBySlug']>>) {
    return ns ? knowledgeNamespaceProjection(ns) : null;
  }
  private async destination(owner: UserID, bundle: string, slug: string) {
    const receipt = await new KnowledgeTransferRepository(this.db).receipt(owner, bundle, slug, '');
    if (!receipt) return null;
    const ns = await new KnowledgeNamespaceRepository(this.db).findById(receipt.target_id);
    if (
      !ns ||
      ns.archived ||
      ns.slug !== slug ||
      ns.owner_user_id !== owner ||
      ns.others_can !== 'none' ||
      ns.visibility_default !== 'private'
    ) {
      throw new Conflict('Import destination changed or was archived; refusing to recreate it');
    }
    if (
      receipt.digest !==
      transferDigest({ display_name: ns.display_name, description: ns.description ?? null })
    )
      throw new Conflict('Import namespace metadata changed');
    const acl = await new KnowledgeNamespaceRepository(this.db).listNamespaceAcl(ns.namespace_id);
    if (
      acl.some(
        (entry) =>
          entry.subject_type !== 'user' || entry.subject_id !== owner || entry.permission !== 'own'
      )
    )
      throw new Conflict('Import destination sharing changed');
    return ns;
  }
  private async unchanged(targetId: string, owner: UserID, namespaceId: string, digest: string) {
    return (
      (await new KnowledgeTransferRepository(this.db).currentDigest(
        targetId,
        owner,
        namespaceId
      )) === digest
    );
  }
  async find(params?: TransferParams): Promise<KnowledgeTransferPage> {
    const user = this.user(params);
    const query = parseTransfer(querySchema, params?.query, 'GET');
    const repo = new KnowledgeTransferRepository(this.db);
    if (!query.bundle) {
      const ns = await this.source(query.namespace, user);
      return {
        namespace: this.namespaceProjection(ns),
        receipts: [],
        ...(await repo.inventory(ns.namespace_id, query.cursor)),
      };
    }
    const ns = await this.destination(user.user_id, query.bundle, query.namespace);
    if (!ns) {
      if (await new KnowledgeNamespaceRepository(this.db).findBySlug(query.namespace))
        throw new Conflict(
          'Destination namespace already exists; import only supports a new namespace or same-bundle resume'
        );
      return { namespace: null, entries: [], receipts: [], total: 0, next_cursor: null };
    }
    const rows = await repo.receipts(user.user_id, query.bundle, query.namespace, query.cursor);
    const page = rows.slice(0, KNOWLEDGE_TRANSFER.pageSize);
    const receipts = [];
    const usage = await repo.usage(user.user_id, query.bundle, query.namespace);
    for (const row of page)
      receipts.push({
        key: row.entry_key,
        reconciled: row.reconciled_count === usage.count,
        target_id: row.target_id,
        digest: row.digest,
        unchanged: await this.unchanged(row.target_id, user.user_id, ns.namespace_id, row.digest),
      });
    return {
      namespace: this.namespaceProjection(ns),
      entries: [],
      receipts,
      total: usage.count,
      next_cursor: rows.length > page.length ? page.at(-1)!.entry_key : null,
    };
  }
  async get(id: string, params?: TransferParams): Promise<KnowledgeTransferBody> {
    const user = this.user(params);
    const query = parseTransfer(
      z.object({ namespace: knowledgeTransferSlug, version: z.string().uuid() }).strict(),
      params?.query,
      'GET',
      'document'
    );
    const ns = await this.source(query.namespace, user);
    const doc = await new KnowledgeDocumentRepository(this.db).findById(
      parseTransfer(z.string().uuid(), id, 'GET', 'document')
    );
    if (!doc || doc.archived || doc.namespace_id !== ns.namespace_id)
      throw new NotFound('Knowledge document not found');
    const header = await new KnowledgeTransferRepository(this.db).versionHeader(
      query.version,
      doc.document_id
    );
    if (
      header?.mime !== 'text/markdown' ||
      header.hasBlob ||
      header.bytes === null ||
      header.bytes > KNOWLEDGE_TRANSFER.maxDocumentBytes
    )
      throw new BadRequest('Unsupported or oversized Knowledge version');
    const version = await new KnowledgeDocumentVersionRepository(this.db).findById(query.version);
    if (
      !version ||
      version.document_id !== doc.document_id ||
      version.mime_type !== 'text/markdown' ||
      typeof version.content_text !== 'string'
    )
      throw new BadRequest('Unsupported or missing Knowledge version');
    const bytes = Buffer.byteLength(version.content_text, 'utf8');
    if (bytes > KNOWLEDGE_TRANSFER.maxDocumentBytes)
      throw new BadRequest('Document exceeds transfer limit');
    const sha256 = transferSha256(version.content_text);
    if (version.content_sha256 && sha256 !== version.content_sha256)
      throw new Conflict('Stored content checksum mismatch');
    return { content: version.content_text, bytes, sha256 };
  }
  async create(input: unknown, params?: TransferParams): Promise<KnowledgeTransferWriteResult> {
    const user = this.user(params);
    const data = parseTransfer(knowledgeTransferWriteSchema, input, 'POST');
    if (transferRequestBytes(data) > KNOWLEDGE_TRANSFER.maxRequestBytes)
      throw new BadRequest('Transfer request exceeds size limit');
    if (
      data.action === 'document' &&
      (Buffer.byteLength(data.content, 'utf8') !== data.entry.bytes ||
        transferSha256(data.content) !== data.entry.sha256)
    )
      throw new BadRequest('Content does not match transfer plan');
    return runKnowledgePolicyTransaction(this.db, async (tx) => {
      // Same lock order as normal content writes, and serialization of duplicate create receipts.
      await new KnowledgeSemanticSettingsRepository(tx).lockAggregateForUpdate(tx);
      // This handle is already scoped by runKnowledgePolicyTransaction; never escapes this unit.
      const scoped = tx as unknown as TenantScopeAwareDatabase;
      const service = new KnowledgeTransfersService(scoped, this.app);
      const repo = new KnowledgeTransferRepository(tx);
      const namespaces = new KnowledgeNamespaceRepository(tx);
      if (data.action === 'namespace') {
        const previous = await service.destination(user.user_id, data.bundle, data.slug);
        if (previous) {
          if (!data.resume) throw new Conflict('Import exists; use --resume');
          if (
            previous.display_name !== data.display_name ||
            (previous.description ?? null) !== data.description
          )
            throw new Conflict('Import plan changed');
          return { target_id: previous.namespace_id, skipped: true };
        }
        if (await namespaces.findBySlug(data.slug))
          throw new Conflict('Destination namespace already exists');
        const ns = await namespaces.create({
          slug: data.slug,
          display_name: data.display_name,
          description: data.description,
          kind: 'global',
          owner_user_id: user.user_id,
          created_by: user.user_id,
          others_can: 'none',
          visibility_default: 'private',
        });
        await namespaces.upsertNamespaceAclEntry({
          namespace_id: ns.namespace_id,
          subject_type: 'user',
          subject_id: user.user_id,
          permission: 'own',
          created_by: user.user_id,
        });
        await repo.record(
          user.user_id,
          data.bundle,
          data.slug,
          '',
          ns.namespace_id,
          transferDigest({ display_name: data.display_name, description: data.description })
        );
        if (this.app)
          emitServiceEvent(this.app, {
            path: 'kb/namespaces',
            event: 'created',
            data: ns,
            params,
            id: ns.namespace_id,
          });
        return { target_id: ns.namespace_id, skipped: false };
      }
      const ns = await service.destination(user.user_id, data.bundle, data.slug);
      if (!ns) throw new Conflict('Create the import namespace first');
      const key = data.action === 'document' ? data.entry.key : data.key;
      const previous = await repo.receipt(user.user_id, data.bundle, data.slug, key);
      if (previous) {
        if (
          !(await service.unchanged(
            previous.target_id,
            user.user_id,
            ns.namespace_id,
            previous.digest
          ))
        )
          throw new Conflict(`Imported document changed: ${key}`);
        if (data.action === 'document' && previous.digest !== transferEntryDigest(data.entry))
          throw new Conflict('Import plan changed');
        if (data.action === 'reconcile') {
          const usage = await repo.usage(user.user_id, data.bundle, data.slug);
          if (previous.reconciled_count !== usage.count) {
            await new KnowledgeDocumentsService(scoped, this.app).reconcileReferences(
              previous.target_id,
              params
            );
            await repo.markReconciled(user.user_id, data.bundle, data.slug, key, usage.count);
          }
        }
        return { target_id: previous.target_id, skipped: true };
      }
      if (data.action === 'reconcile') throw new Conflict('Document import has not completed');
      const usage = await repo.usage(user.user_id, data.bundle, data.slug);
      const requestBytes = transferRequestBytes(data);
      if (
        usage.count >= KNOWLEDGE_TRANSFER.maxDocuments ||
        usage.bytes + requestBytes > KNOWLEDGE_TRANSFER.maxTotalRequestBytes
      )
        throw new BadRequest('Import exceeds namespace transfer limits');
      const documents = new KnowledgeDocumentsService(scoped, this.app);
      const created = await documents.create(
        {
          namespace_id: ns.namespace_id,
          path: data.entry.path,
          title: data.entry.title,
          icon_emoji: data.entry.icon_emoji,
          kind: data.entry.kind,
          status: data.entry.status,
          visibility: 'private',
          edit_policy: 'owner',
          content_text: data.content,
          frontmatter: data.entry.frontmatter,
          metadata: transferDocumentMetadata(data.entry),
          change_summary: 'Imported current Knowledge document',
        },
        params
      );
      if (Array.isArray(created)) throw new Error('Unexpected bulk Knowledge result');
      await repo.record(
        user.user_id,
        data.bundle,
        data.slug,
        key,
        created.document_id,
        transferEntryDigest(data.entry),
        requestBytes
      );
      if (this.app)
        emitServiceEvent(this.app, {
          path: 'kb/documents',
          event: 'created',
          data: created,
          params,
          id: created.document_id,
        });
      return { target_id: created.document_id, skipped: false };
    });
  }
}

// ---------------------------------------------------------------------------
// In-process repository export/import for `.agor`
// ---------------------------------------------------------------------------

/** Older versions kept per document when "+version history" is exported. */
const PACK_HISTORY_VERSIONS_PER_DOCUMENT = 50;

export interface KnowledgeRepositoryExport {
  /** Repository v2 files: `manifest.yaml` and `docs/**.md`, as `agor kb export` writes them. */
  files: Array<{ path: string; content: string }>;
  documents: number;
  history: AgorPackKnowledgeHistory | null;
  historyVersions: number;
  /** Links to other namespaces, kept as-is (by target namespace slug). */
  outsideLinks: AgorPackOutsideLinks;
  /** Live documents the exporter may not read, left out. */
  privateSkipped: number;
}

/**
 * Count links in `bodies` that point outside `sourceSlug`. Document-id links
 * resolve to their namespace; one to a missing/archived document is broken,
 * not outside, and is not counted.
 */
async function summarizeOutsideLinks(
  db: TenantScopeAwareDatabase,
  user: User,
  sourceSlug: string,
  ownIds: Set<string>,
  bodies: Iterable<string>
): Promise<AgorPackOutsideLinks> {
  const documents = new KnowledgeDocumentRepository(db);
  const namespaces = new KnowledgeNamespaceRepository(db);
  const slugs = new Set<string>();
  let count = 0;
  for (const body of bodies) {
    for (const link of outsideKnowledgeLinks(body, sourceSlug, (id) => ownIds.has(id))) {
      let slug: string | null = null;
      if ('slug' in link) slug = link.slug;
      else {
        const doc = await documents.findById(link.documentId).catch(() => null);
        if (doc && !doc.archived && (await canReadKnowledgeDocument(namespaces, doc, user))) {
          slug = (await namespaces.findById(doc.namespace_id))?.slug ?? null;
        }
      }
      if (!slug || slug === sourceSlug) continue;
      count += 1;
      slugs.add(slug);
    }
  }
  return { count, namespaces: [...slugs].sort() };
}

/**
 * Every live document row of a namespace the user may read, across inventory
 * pages, and how many were left out by document visibility.
 */
async function inventoryRows(
  db: TenantScopeAwareDatabase,
  namespaceId: string,
  user: User
): Promise<{ rows: KnowledgeTransferInventoryEntry[]; privateSkipped: number }> {
  const transfers = new KnowledgeTransferRepository(db);
  const documents = new KnowledgeDocumentRepository(db);
  const namespaces = new KnowledgeNamespaceRepository(db);
  const rows: KnowledgeTransferInventoryEntry[] = [];
  let privateSkipped = 0;
  for (let cursor = ''; ; ) {
    const page = await transfers.inventory(namespaceId, cursor);
    for (const row of page.entries) {
      const doc = await documents.findById(row.document_id);
      if (doc && (await canReadKnowledgeDocument(namespaces, doc, user))) rows.push(row);
      else privateSkipped += 1;
    }
    if (!page.next_cursor) return { rows, privateSkipped };
    cursor = page.next_cursor;
  }
}

/**
 * What a teammate pack's Knowledge section would hold, for the export
 * preflight: documents `user` may read, archived and private ones left out,
 * and outside links. Must run inside a tenant database scope.
 */
export async function previewKnowledgeExport(
  db: TenantScopeAwareDatabase,
  namespaceId: string,
  user: User
): Promise<{
  documents: number;
  /** Markdown body size, for the export size estimate. */
  bytes: number;
  archived: number;
  privateSkipped: number;
  outsideLinks: AgorPackOutsideLinks;
}> {
  const ns = await new KnowledgeNamespaceRepository(db).findById(namespaceId);
  if (!ns || ns.archived) {
    return {
      documents: 0,
      bytes: 0,
      archived: 0,
      privateSkipped: 0,
      outsideLinks: { count: 0, namespaces: [] },
    };
  }
  const transfers = new KnowledgeTransferRepository(db);
  const versions = new KnowledgeDocumentVersionRepository(db);
  const { rows, privateSkipped } = await inventoryRows(db, ns.namespace_id, user);
  const bodies: string[] = [];
  for (const row of rows) {
    if (row.mime_type !== 'text/markdown' || !row.version_id) continue;
    const version = await versions.findById(row.version_id);
    if (typeof version?.content_text === 'string') bodies.push(version.content_text);
  }
  return {
    documents: rows.length,
    bytes: bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0),
    archived: await transfers.archivedCount(ns.namespace_id),
    privateSkipped,
    outsideLinks: await summarizeOutsideLinks(
      db,
      user,
      ns.slug,
      new Set(rows.map((row) => String(row.document_id))),
      bodies
    ),
  };
}

/**
 * Export a namespace's current Markdown documents as Knowledge repository v2
 * files — the same encoders and link rewriting as `agor kb export`, without
 * the HTTP round trips. Only documents `options.user` may read are exported
 * (with their history). Must run inside a tenant database scope. Optional
 * history carries up to {@link PACK_HISTORY_VERSIONS_PER_DOCUMENT} older
 * versions per document, oldest first.
 */
export async function exportKnowledgeRepository(
  db: TenantScopeAwareDatabase,
  namespaceId: string,
  options: {
    user: User;
    includeHistory: boolean;
    authorOf: (userId: string | null) => Promise<AgorPackAuthor>;
  }
): Promise<KnowledgeRepositoryExport> {
  const ns = await new KnowledgeNamespaceRepository(db).findById(namespaceId);
  if (!ns || ns.archived) throw new NotFound('Knowledge namespace not found');
  const versions = new KnowledgeDocumentVersionRepository(db);
  const { rows, privateSkipped } = await inventoryRows(db, ns.namespace_id, options.user);
  const documents: KnowledgeTransferEntry[] = [];
  const bodies = new Map<string, string>();
  const omissions = new Set<string>(['acl', 'graph', 'assets']);
  for (const row of rows) {
    if (row.mime_type !== 'text/markdown' || !row.version_id) {
      omissions.add('non-markdown documents');
      continue;
    }
    const version = await versions.findById(row.version_id);
    if (typeof version?.content_text !== 'string') continue;
    const key = `d${String(documents.length + 1).padStart(6, '0')}`;
    documents.push(
      transferInventoryEntry(
        row,
        key,
        transferSha256(version.content_text),
        Buffer.byteLength(version.content_text, 'utf8')
      )
    );
    bodies.set(key, version.content_text);
  }
  if (!options.includeHistory) omissions.add('history');
  const manifest = completedTransferManifest({
    exported_at: new Date().toISOString(),
    namespace: knowledgeNamespaceProjection(ns),
    documents,
    omissions: [...omissions].sort(),
  });
  const repository = knowledgeRepositoryWriter(manifest);
  const files: KnowledgeRepositoryExport['files'] = [
    { path: KNOWLEDGE_REPOSITORY.manifest, content: repository.manifestYaml() },
  ];
  for (const doc of manifest.documents) {
    const { file, content } = repository.document(doc, bodies.get(doc.key) as string);
    files.push({ path: file, content });
  }

  let history: AgorPackKnowledgeHistory | null = null;
  let historyVersions = 0;
  if (options.includeHistory) {
    history = { version: 1, documents: [] };
    for (const row of rows) {
      if (!row.version_id || row.mime_type !== 'text/markdown') continue;
      const older = (await versions.findAll({ document_id: row.document_id as never }))
        .filter((v) => v.version_id !== row.version_id && typeof v.content_text === 'string')
        .slice(0, PACK_HISTORY_VERSIONS_PER_DOCUMENT)
        .reverse();
      if (older.length === 0) continue;
      const entries = [];
      for (const v of older) {
        entries.push({
          version_number: v.version_number,
          title: null,
          content: v.content_text as string,
          change_summary: v.change_summary ?? null,
          created_at: new Date(v.created_at).toISOString(),
          originally_by: await options.authorOf(v.created_by ?? null),
        });
      }
      history.documents.push({ path: row.path, versions: entries });
      historyVersions += entries.length;
    }
  }
  const outsideLinks = await summarizeOutsideLinks(
    db,
    options.user,
    ns.slug,
    new Set(rows.map((row) => String(row.document_id))),
    bodies.values()
  );
  return {
    files,
    documents: manifest.documents.length,
    history,
    historyVersions,
    outsideLinks,
    privateSkipped,
  };
}

/**
 * Import Knowledge repository v2 files into an EXISTING namespace the caller
 * owns (an imported teammate's memory namespace). Same decoding and link
 * rewriting as `agor kb import`, but documents land in the given namespace and
 * inherit its visibility defaults. A path that already exists (seeded) is
 * overwritten unless it already holds the pack's content. Older versions, when present, are replayed oldest-first before
 * the current content so the document's history reads naturally.
 */
export async function importKnowledgeRepository(input: {
  db: TenantScopeAwareDatabase;
  app?: Application;
  params: AuthenticatedParams;
  namespace: { namespace_id: string; slug: string };
  files: Map<string, string>;
  history: AgorPackKnowledgeHistory | null;
  importMetadata: Record<string, unknown>;
}): Promise<{ documents: number; unresolvedLinks: number }> {
  const manifestText = input.files.get(KNOWLEDGE_REPOSITORY.manifest);
  if (!manifestText) throw new BadRequest('Knowledge section is missing manifest.yaml');
  let plan: ReturnType<typeof planKnowledgeRepositoryImport>;
  try {
    const index = validateRepositoryManifest(parseKnowledgeYaml(manifestText));
    plan = planKnowledgeRepositoryImport(
      index,
      index.documents.map((file) => decodeKnowledgeRepositoryFile(file, input.files.get(file))),
      input.namespace.slug
    );
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : 'Invalid Knowledge section');
  }
  const historyByPath = new Map(
    (input.history?.documents ?? []).map((doc) => [doc.path, doc.versions])
  );
  const documents = new KnowledgeDocumentsService(input.db, input.app);
  const repository = new KnowledgeDocumentRepository(input.db);
  const versions = new KnowledgeDocumentVersionRepository(input.db);
  const written: string[] = [];
  // Links into other namespaces stay as-is by design; the export already
  // reported them, so only genuinely broken links count here.
  let unresolvedLinks = plan.unresolved - plan.outside;
  const localize = (body: string, file: string) => {
    const local = plan.localize(body, file);
    unresolvedLinks += local.unresolved - local.outside;
    return local.content;
  };
  for (const entry of plan.manifest.documents) {
    const doc = plan.documents.get(entry.key);
    if (!doc) continue;
    const metadata = { ...transferDocumentMetadata(entry), ...input.importMetadata };
    const steps = [
      ...(historyByPath.get(entry.path) ?? []).map((version) => ({
        content: localize(version.content, doc.file),
        // The original change summary when the source had one.
        summary:
          version.change_summary ??
          `Imported version ${version.version_number}${
            version.originally_by.name ? ` (originally by ${version.originally_by.name})` : ''
          }`,
      })),
      { content: doc.content, summary: 'Imported current Knowledge document' },
    ];
    const existing = await repository.findByNamespaceAndPath(
      input.namespace.namespace_id as never,
      entry.path
    );
    let documentId = existing?.document_id as string | undefined;
    const current = existing?.current_version_id
      ? await versions.findById(existing.current_version_id)
      : null;
    if (documentId && current?.content_text === doc.content) {
      // Already imported (a resumed import): don't replay its history again.
      written.push(documentId);
      continue;
    }
    // The whole replay (history + current) is one transaction: a document
    // is either fully imported or not at all, so a resume never repeats a
    // version. Same unit and lock order as a Knowledge transfer write.
    documentId = await runKnowledgePolicyTransaction(input.db, async (tx) => {
      await new KnowledgeSemanticSettingsRepository(tx).lockAggregateForUpdate(tx);
      // Scoped by runKnowledgePolicyTransaction; never escapes this unit.
      const scoped = new KnowledgeDocumentsService(
        tx as unknown as TenantScopeAwareDatabase,
        input.app
      );
      let id = documentId;
      for (const step of steps) {
        if (!id) {
          const created = await scoped.create(
            {
              namespace_id: input.namespace.namespace_id as never,
              path: entry.path,
              title: entry.title,
              icon_emoji: entry.icon_emoji,
              kind: entry.kind,
              status: entry.status,
              content_text: step.content,
              frontmatter: entry.frontmatter,
              metadata,
              change_summary: step.summary,
            },
            input.params
          );
          if (Array.isArray(created)) throw new Error('Unexpected bulk Knowledge result');
          id = created.document_id;
        } else {
          await scoped.patch(
            id,
            {
              title: entry.title,
              content_text: step.content,
              frontmatter: entry.frontmatter,
              change_summary: step.summary,
            },
            input.params
          );
        }
      }
      return id;
    });
    if (documentId) written.push(documentId);
  }
  for (const id of written) await documents.reconcileReferences(id, input.params);
  return { documents: written.length, unresolvedLinks };
}
