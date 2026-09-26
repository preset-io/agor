import { PAGINATION } from '@agor/core/config';
import type { HydratedKnowledgeDocument, KnowledgeDocumentStatus } from '@agor/core/types';
import { normalizeKnowledgePath } from '@agor/core/types';
import type { AuthenticatedAgorClient } from '@agor-live/client';
import { Flags } from '@oclif/core';
import Table from 'cli-table3';

export async function listNamespaces(client: AuthenticatedAgorClient) {
  const rows = await client.service('kb/namespaces').findAll();
  return rows.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function namespaceBySlug(client: AuthenticatedAgorClient, slug: string) {
  const rows = await client.service('kb/namespaces').findAll({ query: { slug } });
  if (rows.length !== 1) throw new Error(`Namespace not found or not accessible: ${slug}`);
  return rows[0];
}

export async function listDocuments(
  client: AuthenticatedAgorClient,
  slug: string,
  status?: KnowledgeDocumentStatus,
  path?: string
) {
  const namespace = await namespaceBySlug(client, slug);
  const rows = await client.service('kb/documents').findAll({
    query: {
      namespace_id: namespace.namespace_id,
      include_other_user_drafts: true,
      ...(status ? { status } : {}),
      ...(path ? { path: normalizeKnowledgePath(path) } : {}),
    },
  });
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export async function getDocument(client: AuthenticatedAgorClient, slug: string, path: string) {
  const rows = await listDocuments(client, slug, undefined, path);
  if (rows.length !== 1) throw new Error(`Document not found or not accessible: ${slug}/${path}`);
  const document = (await client.service('kb/documents').get(rows[0].document_id, {
    query: { include_content: true },
  })) as HydratedKnowledgeDocument;
  if (
    typeof document.content !== 'string' ||
    document.current_version?.mime_type !== 'text/markdown'
  )
    throw new Error('Document has no readable current Markdown content');
  return document;
}

/** Display pagination over the existing permission-filtered array APIs. */
export function page<T>(rows: T[], limit: number, offset: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error('--limit must be a positive integer and --offset a nonnegative integer');
  return { total: rows.length, limit, offset, data: rows.slice(offset, offset + limit) };
}

export function table(headers: string[], rows: unknown[][]) {
  const result = new Table({ head: headers, style: { head: [], border: [] } });
  result.push(...rows.map((row) => row.map((value) => terminalText(String(value ?? '—')))));
  return result.toString();
}

export function terminalText(text: string) {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal control characters.
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

export function pageSummary(result: { data: unknown[]; total: number; offset: number }) {
  const count = result.data.length;
  return `Showing ${count} of ${result.total}${count ? ` (${result.offset + 1}–${result.offset + count})` : ''}; accessible, active entries only.`;
}

/** Return fresh flag definitions for each oclif command. */
export function knowledgeListFlags() {
  return {
    limit: Flags.integer({
      default: PAGINATION.CLI_DEFAULT_LIMIT,
      min: 1,
      description: 'Maximum rows to display',
    }),
    offset: Flags.integer({ default: 0, min: 0, description: 'Number of sorted rows to skip' }),
    json: Flags.boolean({ description: 'Output JSON with total, limit, offset and data' }),
  };
}

export function renderKnowledgePage<T>(
  result: ReturnType<typeof page<T>>,
  json: boolean,
  headers: string[],
  row: (value: T) => unknown[]
) {
  return json
    ? JSON.stringify(result)
    : `${table(headers, result.data.map(row))}\n${pageSummary(result)}`;
}
