/**
 * The board's Files list (`boards/:id/files`): what was made or shared on a
 * board, across artifacts, knowledge documents, branches with an app or pull
 * request, and conversation uploads. Read-only; every item is filtered by the
 * caller's own access before it is returned.
 */

import type { BranchID, SessionID, UserID } from './id';

export const BOARD_FILE_KINDS = ['artifact', 'document', 'app', 'upload'] as const;
export type BoardFileKind = (typeof BOARD_FILE_KINDS)[number];

export const BOARD_FILE_SORTS = ['recent', 'name', 'type'] as const;
export type BoardFileSort = (typeof BOARD_FILE_SORTS)[number];

/** One page holds at most this many items. */
export const BOARD_FILES_PAGE_SIZE = 50;

/** A teammate made it, or a person did. */
export type BoardFileMadeBy =
  | { teammate_branch_id?: BranchID; name: string; emoji?: string }
  | { user_id: UserID };

/**
 * Where it came from: a conversation the caller can see, one they cannot
 * ('private'), or none ('board').
 */
export type BoardFileSource = { session_id: SessionID; title: string } | 'private' | 'board';

export interface BoardFileItem {
  kind: BoardFileKind;
  /** artifact_id, document_id, branch_id or upload ref. */
  id: string;
  name: string;
  /** ISO time it was last made or changed. */
  made_at: string;
  made_by: BoardFileMadeBy;
  source: BoardFileSource;
  /** Only with `include_archived`. */
  archived?: boolean;
  /** Live, Draft, Shared, Ready to review. Uploads show their type and size instead. */
  status?: string;
  /** Uploads. */
  mime_type?: string;
  size_bytes?: number;
  /** Apps and pull requests. */
  app_url?: string;
  pull_request_url?: string;
}

export interface BoardFilesQuery {
  /** Search text, matched token by token against the name, artifact description and document path. */
  q?: string;
  kind?: BoardFileKind | { $in: BoardFileKind[] };
  sort?: BoardFileSort;
  session_id?: SessionID;
  /** Only together with `session_id` (work cards keep archived items, greyed). */
  include_archived?: boolean;
  $limit?: number;
  $skip?: number;
}

export interface BoardFilesPage {
  total: number;
  limit: number;
  skip: number;
  data: BoardFileItem[];
}

/** The type names people see, one per kind. "Type" sort orders by these. */
export const BOARD_FILE_KIND_LABELS: Record<BoardFileKind, string> = {
  artifact: 'Artifact',
  document: 'Document',
  app: 'App and pull request',
  upload: 'Upload',
};
