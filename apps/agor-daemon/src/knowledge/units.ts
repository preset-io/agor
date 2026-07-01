import type { AgorConfig } from '@agor/core/config';
import {
  and,
  eq,
  KnowledgeDocumentRepository,
  kbDocuments,
  kbDocumentVersions,
  kbNamespaces,
  type ReplaceKnowledgeUnitInput,
  select,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { KnowledgeDocumentVersionID } from '@agor/core/types';
import { DEFAULT_KNOWLEDGE_CHUNKING } from './embeddings.js';
import { chunkMarkdownForKnowledge, type MarkdownChunkerOptions } from './markdown-chunker.js';

export function knowledgeChunkerOptionsFromConfig(config: AgorConfig): MarkdownChunkerOptions {
  const chunking = config.knowledge?.semantic_search?.chunking ?? {};
  return {
    targetTokens: chunking.target_tokens ?? DEFAULT_KNOWLEDGE_CHUNKING.target_tokens,
    maxTokens: chunking.max_tokens ?? DEFAULT_KNOWLEDGE_CHUNKING.max_tokens,
    overlapTokens: chunking.overlap_tokens ?? DEFAULT_KNOWLEDGE_CHUNKING.overlap_tokens,
    minTokens: chunking.min_tokens ?? DEFAULT_KNOWLEDGE_CHUNKING.min_tokens,
  };
}

export function knowledgeUnitsForMarkdown(
  documentPath: string,
  content: string,
  options: MarkdownChunkerOptions
): ReplaceKnowledgeUnitInput[] {
  return chunkMarkdownForKnowledge(content, options).map((chunk) => ({
    kind: chunk.kind,
    ordinal: chunk.ordinal,
    path_anchor: chunk.path_anchor,
    heading_path: chunk.heading_path,
    source_path: documentPath,
    content_text: chunk.content_text,
    content_md5: chunk.content_md5,
    start_offset: chunk.start_offset,
    end_offset: chunk.end_offset,
    metadata: {
      ...(chunk.metadata ?? {}),
      document_path: documentPath,
    },
  }));
}

export async function rebuildCurrentKnowledgeUnits(
  db: TenantScopeAwareDatabase,
  config: AgorConfig,
  options: { embeddingConfigured: boolean }
): Promise<number> {
  const rows = (await select(db)
    .from(kbDocuments)
    .innerJoin(
      kbDocumentVersions,
      eq(kbDocuments.current_version_id, kbDocumentVersions.version_id)
    )
    .innerJoin(kbNamespaces, eq(kbDocuments.namespace_id, kbNamespaces.namespace_id))
    .where(and(eq(kbDocuments.archived, false), eq(kbNamespaces.archived, false)))
    .all()) as Array<Record<string, unknown>>;

  const documents = new KnowledgeDocumentRepository(db);
  const chunkerOptions = knowledgeChunkerOptionsFromConfig(config);
  let queued = 0;
  for (const row of rows) {
    const document = row.kb_documents as typeof kbDocuments.$inferSelect;
    const version = row.kb_document_versions as typeof kbDocumentVersions.$inferSelect;
    if (!document.current_version_id || typeof version.content_text !== 'string') continue;
    const units = knowledgeUnitsForMarkdown(document.path, version.content_text, chunkerOptions);
    await documents.replaceUnitsForVersion(
      document.current_version_id as KnowledgeDocumentVersionID,
      units,
      {
        embeddingConfigured: options.embeddingConfigured,
      }
    );
    queued += units.length;
  }
  return queued;
}
