import type { Database } from '@agor/core/db';
import { KnowledgeDocumentVersionRepository, KnowledgeNamespaceRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import { applyKnowledgeEditOps, KnowledgeEditError } from '@agor/core/knowledge';
import type {
  AuthenticatedParams,
  KnowledgeDocument,
  KnowledgeDocumentVersion,
  KnowledgeEditChangedRange,
  KnowledgeEditOp,
  KnowledgeVersionToken,
  User,
} from '@agor/core/types';
import { createTwoFilesPatch, structuredPatch } from 'diff';
import { canWriteKnowledgeDocument } from './knowledge-access.js';
import type { KnowledgeDocumentParams, KnowledgeDocumentsService } from './knowledge-documents.js';

interface KnowledgeDocumentEditInput {
  documentId?: string;
  uri?: string;
  namespace?: string;
  path?: string;
  expectedVersion?: string | number;
  dryRun?: boolean;
  changeSummary?: string;
  versionMetadata?: Record<string, unknown> | null;
  ops: KnowledgeEditOp[];
  returnContent?: 'none' | 'full';
}

interface KnowledgeDocumentEditResponse {
  dryRun: boolean;
  document: KnowledgeDocument;
  baseVersion: KnowledgeVersionToken;
  newVersion?: KnowledgeVersionToken;
  diff: string;
  changedRanges: KnowledgeEditChangedRange[];
  content?: string;
}

function versionToToken(version: KnowledgeDocumentVersion): KnowledgeVersionToken {
  return {
    version_id: version.version_id,
    version_number: version.version_number,
    content_sha256: version.content_sha256 ?? null,
    etag: `kbv:${version.version_id}`,
  };
}

function extractChangedRanges(
  baseContent: string,
  updatedContent: string
): KnowledgeEditChangedRange[] {
  const patch = structuredPatch('', '', baseContent, updatedContent, '', '');
  return patch.hunks
    .filter((hunk) => hunk.newLines > 0)
    .map((hunk) => {
      const content = hunk.lines
        .filter((line) => line.startsWith('+'))
        .map((line) => line.slice(1))
        .join('\n');
      return {
        start_line: hunk.newStart,
        end_line: hunk.newStart + Math.max(hunk.newLines - 1, 0),
        content,
      } satisfies KnowledgeEditChangedRange;
    });
}

export class KnowledgeDocumentEditsService {
  constructor(
    db: Database,
    private readonly documentsService: KnowledgeDocumentsService,
    private readonly versionRepo = new KnowledgeDocumentVersionRepository(db),
    private readonly namespaceRepo = new KnowledgeNamespaceRepository(db)
  ) {}

  private async ensureCanEdit(document: KnowledgeDocument, user: User | undefined) {
    if (await canWriteKnowledgeDocument(this.namespaceRepo, document, user)) return;
    throw new Forbidden('You do not have permission to edit this knowledge document');
  }

  async create(
    data: KnowledgeDocumentEditInput,
    params?: AuthenticatedParams
  ): Promise<KnowledgeDocumentEditResponse> {
    if (!data || !Array.isArray(data.ops) || data.ops.length === 0) {
      throw new BadRequest('ops must be a non-empty array');
    }

    const dryRun = data.dryRun === true;

    const ref: Record<string, unknown> = { include_content: true };
    if (data.documentId) ref.document_id = data.documentId;
    if (data.uri) ref.uri = data.uri;
    if (data.namespace) ref.namespace_slug = data.namespace;
    if (data.path) ref.path = data.path;

    const baseParams = (params ?? {}) as KnowledgeDocumentParams;
    const documentParams: KnowledgeDocumentParams = {
      ...baseParams,
      query: {
        ...(baseParams.query ?? {}),
        include_content: true,
        include_links: false,
        include_indexing: false,
      },
    };

    const documentResult = await this.documentsService.getDocument(ref, documentParams);

    if (!('document' in documentResult) || !documentResult.document) {
      throw new NotFound('Knowledge document not found');
    }

    const document = documentResult.document;
    await this.ensureCanEdit(document, params?.user as User | undefined);

    const currentVersion = documentResult.current_version;
    if (!currentVersion) {
      throw new BadRequest('Knowledge document has no current version to edit');
    }

    const expectedVersion = data.expectedVersion;
    if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== '') {
      const matches =
        String(expectedVersion) === currentVersion.version_id ||
        String(expectedVersion) === String(currentVersion.version_number);
      if (!matches) {
        throw new BadRequest(
          `Knowledge document version mismatch: expected ${expectedVersion}, current is ${currentVersion.version_number}`
        );
      }
    } else if (!dryRun) {
      throw new BadRequest('expectedVersion is required for knowledge document edits');
    }

    const baseContent = typeof documentResult.content === 'string' ? documentResult.content : '';

    let updatedContent: string;
    try {
      const applied = applyKnowledgeEditOps(baseContent, data.ops);
      updatedContent = applied.content;
    } catch (error) {
      if (error instanceof KnowledgeEditError) {
        throw new BadRequest(error.message);
      }
      throw error;
    }

    const diff = createTwoFilesPatch('base', 'updated', baseContent, updatedContent, '', '');
    const changedRanges = extractChangedRanges(baseContent, updatedContent);
    const baseToken = versionToToken(currentVersion);

    const includeContent = data.returnContent === 'full' || dryRun;

    if (updatedContent === baseContent) {
      return {
        dryRun,
        document,
        baseVersion: baseToken,
        diff,
        changedRanges: [],
        content: includeContent ? baseContent : undefined,
      };
    }

    if (dryRun) {
      return {
        dryRun: true,
        document,
        baseVersion: baseToken,
        diff,
        changedRanges,
        content: includeContent ? updatedContent : undefined,
      };
    }

    const metadata = {
      edit_source: 'mcp:agor_kb_edit',
      base_version_id: currentVersion.version_id,
      base_version_number: currentVersion.version_number,
      ops: data.ops,
      session_id: (params as { sessionId?: string } | undefined)?.sessionId ?? null,
    } satisfies Record<string, unknown>;

    const versionMetadata = {
      ...(data.versionMetadata ?? {}),
      ...metadata,
    };

    const updatedDocument = await this.documentsService.putDocument(
      {
        document_id: document.document_id,
        content_text: updatedContent,
        expected_version: expectedVersion ?? currentVersion.version_number,
        change_summary: data.changeSummary,
        version_metadata: versionMetadata,
      },
      baseParams
    );

    const latestVersion = await this.versionRepo.findLatestForDocument(document.document_id);
    const newToken = latestVersion ? versionToToken(latestVersion) : undefined;

    return {
      dryRun: false,
      document: updatedDocument,
      baseVersion: baseToken,
      newVersion: newToken,
      diff,
      changedRanges,
      content: includeContent ? updatedContent : undefined,
    };
  }
}

export function createKnowledgeDocumentEditsService(
  db: Database,
  _app: Application,
  documentsService: KnowledgeDocumentsService
) {
  return new KnowledgeDocumentEditsService(db, documentsService);
}
