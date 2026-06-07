/**
 * Knowledge search service
 */

import { getBaseUrl, loadConfig } from '@agor/core/config';
import {
  AppVariableRepository,
  type Database,
  executeRaw,
  isPostgresDatabase,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  type KnowledgeSearchQuery,
  KnowledgeSearchRepository,
  sql,
} from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  buildKnowledgeUnitUri,
  type KnowledgeSearchResult,
  normalizeKnowledgeFolderPath,
  type QueryParams,
  type User,
} from '@agor/core/types';
import { getKnowledgeUrl } from '@agor/core/utils/url';
import {
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  embeddingToPgvector,
  KNOWLEDGE_EMBEDDINGS_API_KEY,
  KNOWLEDGE_EMBEDDINGS_NAMESPACE,
  OpenAIEmbeddingProvider,
  SUPPORTED_OPENAI_EMBEDDING_MODELS,
} from '../knowledge/embeddings.js';
import {
  getKnowledgePgvectorCapability,
  semanticUnavailableMessage,
} from '../knowledge/pgvector.js';
import { canReadKnowledgeSearchResult, isKnowledgeAdmin } from './knowledge-access.js';

export type KnowledgeSearchParams = QueryParams<KnowledgeSearchQuery> & AuthenticatedParams;

export class KnowledgeSearchService {
  private repo: KnowledgeSearchRepository;
  private documents: KnowledgeDocumentRepository;
  private namespaces: KnowledgeNamespaceRepository;
  private variables: AppVariableRepository;
  private embeddingProvider = new OpenAIEmbeddingProvider();

  constructor(private db: Database) {
    this.repo = new KnowledgeSearchRepository(db);
    this.documents = new KnowledgeDocumentRepository(db);
    this.namespaces = new KnowledgeNamespaceRepository(db);
    this.variables = new AppVariableRepository(db);
  }

  private async canRead(
    result: Awaited<ReturnType<KnowledgeSearchRepository['search']>>[number],
    user?: User
  ): Promise<boolean> {
    return canReadKnowledgeSearchResult(this.namespaces, result, user);
  }

  private async filterReadable(
    results: KnowledgeSearchResult[],
    user?: User
  ): Promise<KnowledgeSearchResult[]> {
    const readable: KnowledgeSearchResult[] = [];
    for (const result of results) {
      if (await this.canRead(result, user)) readable.push(result);
    }
    return readable;
  }

  private assertSupportedMode(query?: KnowledgeSearchQuery): void {
    const mode = query?.mode ?? 'text';
    if (mode !== 'text' && !isPostgresDatabase(this.db)) {
      throw new BadRequest(
        semanticUnavailableMessage('the configured database is not PostgreSQL'),
        { code: 'semantic_unavailable' }
      );
    }
  }

  private async scopedQuery(
    query: KnowledgeSearchQuery | undefined,
    user?: User
  ): Promise<KnowledgeSearchQuery> {
    this.assertSupportedMode(query);
    const isAdmin = isKnowledgeAdmin(user);
    const rawQuery = (query ?? {}) as KnowledgeSearchQuery & {
      includeMyDrafts?: boolean;
      includeOtherUserDrafts?: boolean;
    };
    const readableNamespaceIds = isAdmin
      ? undefined
      : await this.namespaces.findReadableNamespaceIds(String(user?.user_id ?? ''));
    return {
      ...(query ?? {}),
      include_archived: isAdmin && rawQuery.include_archived === true,
      include_my_drafts: rawQuery.include_my_drafts ?? rawQuery.includeMyDrafts ?? true,
      include_other_user_drafts:
        rawQuery.include_other_user_drafts ?? rawQuery.includeOtherUserDrafts ?? false,
      readable_as_admin: isAdmin,
      readable_by_user_id: user?.user_id,
      readable_namespace_ids: readableNamespaceIds,
    };
  }

  private rawRows(result: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    const rows = (result as { rows?: unknown[] } | undefined)?.rows;
    return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
  }

  private parseMinSimilarity(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw new BadRequest('Knowledge semantic min_similarity must be a number between 0 and 1');
    }
    return parsed;
  }

  private async attachIndexingToResults<T extends KnowledgeSearchResult>(
    results: T[],
    query: KnowledgeSearchQuery
  ): Promise<T[]> {
    if (query.include_indexing !== true && query.includeIndexing !== true) return results;
    const docsWithIndexing = (await this.documents.attachIndexingStatus(
      results.map((result) => result.document)
    )) as T['document'][];
    return results.map((result, index) => ({
      ...result,
      document: docsWithIndexing[index],
    }));
  }

  private async semanticSearch(
    rawQuery: KnowledgeSearchQuery,
    user?: User
  ): Promise<KnowledgeSearchResult[]> {
    if (!isPostgresDatabase(this.db)) {
      throw new BadRequest(
        semanticUnavailableMessage('the configured database is not PostgreSQL'),
        { code: 'semantic_unavailable' }
      );
    }
    const pgvector = await getKnowledgePgvectorCapability(this.db);
    if (!pgvector.available) {
      throw new BadRequest(semanticUnavailableMessage(pgvector.reason), {
        code: 'semantic_unavailable',
        reason: pgvector.reason,
        setup_hint: pgvector.setupHint,
      });
    }
    const config = await loadConfig();
    const semantic = config.knowledge?.semantic_search ?? {};
    if (semantic.enabled !== true) {
      throw new BadRequest(
        'Semantic Knowledge search is disabled. Enable it in Knowledge settings.'
      );
    }
    const provider = semantic.provider ?? 'openai';
    if (provider !== 'openai') throw new BadRequest('Only OpenAI embeddings are implemented');
    const apiKey = await this.variables.getPlain(
      KNOWLEDGE_EMBEDDINGS_NAMESPACE,
      KNOWLEDGE_EMBEDDINGS_API_KEY
    );
    if (!apiKey) throw new BadRequest('Knowledge embedding API key is not configured');

    const model = semantic.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
    if (!SUPPORTED_OPENAI_EMBEDDING_MODELS.has(model)) {
      throw new BadRequest(`Unsupported OpenAI embedding model: ${model}`);
    }
    const dimensions = semantic.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS;
    if (dimensions !== DEFAULT_OPENAI_EMBEDDING_DIMENSIONS) {
      throw new BadRequest(
        'Only 1536-dimensional OpenAI embeddings are supported by the V1 vector table'
      );
    }

    const q = rawQuery.q?.trim() ?? '';
    if (!q) return [];
    const [queryEmbedding] = await this.embeddingProvider.embed(
      [{ id: 'query', text: q, inputType: 'query' }],
      { apiKey, model, dimensions }
    );
    const vector = embeddingToPgvector(queryEmbedding.embedding);
    const limit = Math.min(Math.max(rawQuery.rerank_limit ?? rawQuery.limit ?? 25, 1), 100);
    const isAdmin = isKnowledgeAdmin(user);
    const normalizedPathPrefix = rawQuery.path_prefix?.trim()
      ? normalizeKnowledgeFolderPath(rawQuery.path_prefix)
      : '';
    const pathPrefix = normalizedPathPrefix || null;
    const minSimilarity = this.parseMinSimilarity(rawQuery.min_similarity);
    const includeMyDrafts = rawQuery.include_my_drafts !== false;
    const includeOtherUserDrafts = rawQuery.include_other_user_drafts === true;
    const readableNamespaceIds =
      rawQuery.readable_namespace_ids ??
      (isAdmin
        ? undefined
        : await this.namespaces.findReadableNamespaceIds(String(user?.user_id ?? '')));
    if (readableNamespaceIds?.length === 0) return [];
    const readableNamespaceFilter = readableNamespaceIds
      ? sql`AND d.namespace_id IN (${sql.join(
          readableNamespaceIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      : sql``;

    const baseUrl = await getBaseUrl();
    const result = await executeRaw(
      this.db,
      sql`SELECT
          d.document_id,
          d.namespace_id,
          d.path,
          d.uri,
          d.title,
          d.kind,
          d.visibility,
          d.status,
          d.edit_policy,
          d.current_version_id,
          d.metadata AS document_metadata,
          d.created_by,
          d.created_at,
          d.updated_by,
          d.updated_at,
          ns.slug AS namespace_slug,
          ns.display_name AS namespace_display_name,
          ns.description AS namespace_description,
          ns.kind AS namespace_kind,
          ns.owner_user_id AS namespace_owner_user_id,
          ns.repo_id AS namespace_repo_id,
          ns.branch_id AS namespace_branch_id,
          ns.visibility_default AS namespace_visibility_default,
          ns.others_can AS namespace_others_can,
          ns.metadata AS namespace_metadata,
          ns.created_by AS namespace_created_by,
          ns.created_at AS namespace_created_at,
          ns.updated_at AS namespace_updated_at,
          u.unit_id,
          u.heading_path,
          u.path_anchor,
          u.content_text AS unit_content_text,
          u.start_offset,
          u.end_offset,
          ((e.embedding::vector(1536)) <=> ${vector}::vector(1536)) AS distance
        FROM kb_unit_embeddings e
        JOIN kb_document_units u ON u.unit_id = e.unit_id
        JOIN kb_documents d ON d.document_id = u.document_id AND d.current_version_id = u.version_id
        JOIN kb_namespaces ns ON ns.namespace_id = d.namespace_id
        JOIN kb_embedding_spaces sp ON sp.embedding_space_id = e.embedding_space_id
        WHERE d.archived = false
          AND ns.archived = false
          AND sp.provider = ${provider}
          AND sp.model = ${model}
          AND sp.dimensions = ${dimensions}
          ${readableNamespaceFilter}
          AND (${rawQuery.namespace_id ?? null}::text IS NULL OR d.namespace_id = ${rawQuery.namespace_id ?? null})
          AND (${rawQuery.namespace_slug ?? null}::text IS NULL OR ns.slug = ${rawQuery.namespace_slug ?? null})
          AND (${pathPrefix}::text IS NULL OR d.path = ${pathPrefix} OR d.path LIKE (${pathPrefix} || '/%'))
          AND (${rawQuery.kind ?? null}::text IS NULL OR d.kind = ${rawQuery.kind ?? null})
          AND (${rawQuery.visibility ?? null}::text IS NULL OR d.visibility = ${rawQuery.visibility ?? null})
          AND (${rawQuery.status ?? null}::text IS NULL OR d.status = ${rawQuery.status ?? null})
          AND (${isAdmin}::boolean = true OR d.visibility = 'public' OR d.created_by = ${user?.user_id ?? null})
          AND (
            ${includeOtherUserDrafts}::boolean = true
            OR d.status = 'published'
            OR (${includeMyDrafts}::boolean = true AND d.created_by = ${user?.user_id ?? null})
          )
          AND (${minSimilarity}::float IS NULL OR (1 - ((e.embedding::vector(1536)) <=> ${vector}::vector(1536))) >= ${minSimilarity})
        ORDER BY (e.embedding::vector(1536)) <=> ${vector}::vector(1536)
        LIMIT ${limit}`
    );

    const byDoc = new Map<string, KnowledgeSearchResult>();
    for (const row of this.rawRows(result)) {
      const documentId = String(row.document_id);
      const unitContent = (row.unit_content_text as string | null) ?? '';
      const distance = Number(row.distance);
      const score = 1 - distance;
      const chunk = {
        unit_id: String(row.unit_id) as never,
        reference_uri: buildKnowledgeUnitUri(String(row.unit_id)),
        heading_path: (row.heading_path as string | null) ?? null,
        path_anchor: (row.path_anchor as string | null) ?? null,
        content_text: rawQuery.include_chunks === true ? unitContent : null,
        snippet: unitContent.slice(0, 360),
        score,
        distance,
        start_offset: (row.start_offset as number | null) ?? null,
        end_offset: (row.end_offset as number | null) ?? null,
      };

      const existing = byDoc.get(documentId);
      if (existing) {
        existing.score = Math.max(existing.score, score);
        existing.chunks = [...(existing.chunks ?? []), chunk].slice(0, 3);
        continue;
      }

      byDoc.set(documentId, {
        document: {
          document_id: documentId as never,
          namespace_id: String(row.namespace_id) as never,
          path: String(row.path),
          uri: String(row.uri),
          url: getKnowledgeUrl(String(row.namespace_slug), String(row.path), baseUrl),
          title: String(row.title),
          kind: row.kind as never,
          visibility: row.visibility as never,
          status: (row.status as never) ?? 'published',
          edit_policy: row.edit_policy as never,
          current_version_id: (row.current_version_id as never) ?? null,
          metadata: (row.document_metadata as Record<string, unknown> | null) ?? null,
          created_by: (row.created_by as never) ?? null,
          created_at: new Date(row.created_at as string | number | Date),
          updated_by: (row.updated_by as never) ?? null,
          updated_at: row.updated_at ? new Date(row.updated_at as string | number | Date) : null,
          archived: false,
          archived_at: null,
        },
        namespace: {
          namespace_id: String(row.namespace_id) as never,
          slug: String(row.namespace_slug),
          display_name: String(row.namespace_display_name ?? row.namespace_slug),
          description: (row.namespace_description as string | null) ?? null,
          kind: row.namespace_kind as never,
          owner_user_id: (row.namespace_owner_user_id as never) ?? null,
          repo_id: (row.namespace_repo_id as never) ?? null,
          branch_id: (row.namespace_branch_id as never) ?? null,
          visibility_default: row.namespace_visibility_default as never,
          others_can: row.namespace_others_can as never,
          metadata: (row.namespace_metadata as Record<string, unknown> | null) ?? null,
          created_by: (row.namespace_created_by as never) ?? null,
          created_at: new Date(row.namespace_created_at as string | number | Date),
          updated_at: row.namespace_updated_at
            ? new Date(row.namespace_updated_at as string | number | Date)
            : null,
          archived: false,
          archived_at: null,
        },
        current_version: null,
        snippet: chunk.snippet,
        score,
        mode: 'semantic',
        chunks: [chunk],
      });
    }
    const values = await this.filterReadable([...byDoc.values()], user);
    return this.attachIndexingToResults(values.slice(0, rawQuery.limit ?? 25), rawQuery);
  }

  private hybridMerge(
    textResults: KnowledgeSearchResult[],
    semanticResults: KnowledgeSearchResult[]
  ): KnowledgeSearchResult[] {
    const scores = new Map<string, { result: KnowledgeSearchResult; score: number }>();
    const add = (results: KnowledgeSearchResult[], weight: number) => {
      results.forEach((result, index) => {
        const id = result.document.document_id;
        const current = scores.get(id) ?? { result, score: 0 };
        current.score += weight / (index + 1);
        current.result = { ...current.result, ...result, mode: 'hybrid' };
        scores.set(id, current);
      });
    };
    add(textResults, 1);
    add(semanticResults, 1);
    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .map((item) => ({ ...item.result, score: item.score, mode: 'hybrid' }));
  }

  async find(params?: KnowledgeSearchParams) {
    const user = params?.user as User | undefined;
    const query = await this.scopedQuery(params?.query, user);
    if ((query.mode ?? 'text') === 'semantic') return this.semanticSearch(query, user);

    const textResults = await this.filterReadable(
      await this.repo.search({ ...query, mode: 'text' }),
      user
    );
    const textResultsWithIndexing = await this.attachIndexingToResults(textResults, query);
    if (query.mode === 'hybrid') {
      const semanticResults = await this.semanticSearch(query, user);
      return this.hybridMerge(textResultsWithIndexing, semanticResults).slice(0, query.limit ?? 25);
    }
    return textResultsWithIndexing;
  }

  async create(data: KnowledgeSearchQuery, params?: KnowledgeSearchParams) {
    const user = params?.user as User | undefined;
    const query = await this.scopedQuery(data, user);
    if ((query.mode ?? 'text') === 'semantic') return this.semanticSearch(query, user);

    const textResults = await this.filterReadable(
      await this.repo.search({ ...query, mode: 'text' }),
      user
    );
    const textResultsWithIndexing = await this.attachIndexingToResults(textResults, query);
    if (query.mode === 'hybrid') {
      const semanticResults = await this.semanticSearch(query, user);
      return this.hybridMerge(textResultsWithIndexing, semanticResults).slice(0, query.limit ?? 25);
    }
    return textResultsWithIndexing;
  }
}

export function createKnowledgeSearchService(db: Database): KnowledgeSearchService {
  return new KnowledgeSearchService(db);
}
