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
  transferDigest,
  transferDocumentMetadata,
  transferEntryDigest,
  transferRequestBytes,
  transferSha256,
} from '@agor/core/knowledge';
import type {
  AuthenticatedParams,
  KnowledgeTransferBody,
  KnowledgeTransferPage,
  KnowledgeTransferWriteResult,
  User,
  UserID,
} from '@agor/core/types';
import {
  hasMinimumRole,
  KNOWLEDGE_TRANSFER,
  knowledgeTransferHash,
  knowledgeTransferSlug,
  knowledgeTransferWriteSchema,
  ROLES,
} from '@agor/core/types';
import { z } from 'zod';
import { runKnowledgePolicyTransaction } from '../knowledge/policy-transaction.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { isKnowledgeAdmin } from './knowledge-access.js';
import { KnowledgeDocumentsService } from './knowledge-documents.js';

function parseTransfer<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequest('Invalid Knowledge transfer request', {
      issues: result.error.issues.map(({ path, message }) => ({ path, message })),
    });
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
    if (!ns) return null;
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
    const query = parseTransfer(querySchema, params?.query);
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
      params?.query
    );
    const ns = await this.source(query.namespace, user);
    const doc = await new KnowledgeDocumentRepository(this.db).findById(
      parseTransfer(z.string().uuid(), id)
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
    const data = parseTransfer(knowledgeTransferWriteSchema, input);
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
