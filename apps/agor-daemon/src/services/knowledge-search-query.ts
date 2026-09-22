import type { KnowledgeSearchQuery } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import { KNOWLEDGE_SEARCH_MODES, normalizeKnowledgeFolderPath } from '@agor/core/types';

/** Public input validation precedes capability checks and either search branch. */
export function prepareKnowledgeSearchQuery(query?: KnowledgeSearchQuery): KnowledgeSearchQuery {
  if (query != null && (typeof query !== 'object' || Array.isArray(query))) {
    throw new BadRequest('Knowledge search query must be an object');
  }
  const prepared = { ...query };
  for (const field of [
    'q',
    'namespace_id',
    'namespace_slug',
    'path_prefix',
    'kind',
    'visibility',
    'status',
  ] as const) {
    if (prepared[field] != null && typeof prepared[field] !== 'string') {
      throw new BadRequest(`Knowledge search ${field} must be a string`);
    }
  }
  const mode = prepared.mode ?? 'text';
  if (!KNOWLEDGE_SEARCH_MODES.includes(mode)) {
    throw new BadRequest('Knowledge search mode must be text, semantic, or hybrid');
  }
  prepared.mode = mode;
  for (const field of [
    'include_chunks',
    'include_archived',
    'include_my_drafts',
    'includeMyDrafts',
    'include_other_user_drafts',
    'includeOtherUserDrafts',
    'include_indexing',
    'includeIndexing',
  ] as const) {
    const value: unknown = prepared[field];
    // REST serializes flags as strings. Accept that shape without changing
    // the existing downstream strict-boolean/default interpretation.
    if (value != null && typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
      throw new BadRequest(`Knowledge search ${field} must be a boolean`);
    }
  }
  try {
    prepared.path_prefix = normalizeKnowledgeFolderPath(prepared.path_prefix);
  } catch {
    throw new BadRequest('Knowledge search path_prefix must be a valid Knowledge folder path');
  }
  for (const field of ['limit', 'offset', 'rerank_limit', 'min_similarity'] as const) {
    const value: unknown = prepared[field];
    if (value == null || (field === 'min_similarity' && value === '')) {
      delete prepared[field];
      continue;
    }
    // REST query strings are supported, but arrays, objects and booleans are not numbers.
    const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    if (field === 'min_similarity') {
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new BadRequest('Knowledge semantic min_similarity must be a number between 0 and 1');
      }
    } else if (!Number.isSafeInteger(parsed)) {
      throw new BadRequest(`Knowledge search ${field} must be a finite safe integer`);
    }
    // Leave the established per-mode defaults, clamping and final slicing to their owners.
    prepared[field] = parsed;
  }
  return prepared;
}
