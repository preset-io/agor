import type { Board, BoardComment } from '@agor-live/client';
import { matchSearchTokens, SEARCHABLE_FIELDS, tokenizeSearchQuery } from '@agor-live/client';
import { MIN_QUERY_LENGTH } from './types';
import { byTimestamp } from './utils';

interface SearchCommentsInput {
  query: string;
  commentById: Map<string, BoardComment>;
  /** Boards the caller can see; comments on any other board are never returned. */
  boardById: Map<string, Board>;
  limit: number;
}

/** Newest-first comment matches, using the same tokenizer and field registry as entity search. */
export function searchComments({
  query,
  commentById,
  boardById,
  limit,
}: SearchCommentsInput): BoardComment[] {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];
  const tokens = tokenizeSearchQuery(trimmed);
  if (tokens.length === 0) return [];
  return Array.from(commentById.values())
    .filter((comment) => boardById.has(comment.board_id))
    .filter((comment) => matchSearchTokens(tokens, SEARCHABLE_FIELDS.comment(comment)))
    .sort(byTimestamp((comment) => comment.updated_at))
    .slice(0, limit);
}
