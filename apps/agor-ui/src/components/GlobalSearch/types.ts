import type { Artifact, Board, MCPServer, Repo, Session, Worktree } from '@agor-live/client';

export type SearchEntityType =
  | 'session'
  | 'worktree'
  | 'assistant'
  | 'artifact'
  | 'board'
  | 'mcp';

export type ChipFilter = 'all' | SearchEntityType;

export const TYPE_CHIP_ORDER: ChipFilter[] = [
  'all',
  'session',
  'worktree',
  'assistant',
  'artifact',
  'board',
  'mcp',
];

export const TYPE_CHIP_LABELS: Record<ChipFilter, string> = {
  all: 'All',
  session: 'Sessions',
  worktree: 'Worktrees',
  assistant: 'Assistants',
  artifact: 'Artifacts',
  board: 'Boards',
  mcp: 'MCP',
};

export const TYPE_CHIP_ICONS: Record<SearchEntityType, string> = {
  session: '🤖',
  worktree: '📁',
  assistant: '✨',
  artifact: '🧩',
  board: '🗺️',
  mcp: '🔌',
};

export type SearchResultItem =
  | { type: 'session'; item: Session; parentWorktree?: Worktree; parentRepo?: Repo }
  | { type: 'worktree'; item: Worktree; parentRepo?: Repo }
  | { type: 'assistant'; item: Worktree; parentRepo?: Repo }
  | { type: 'artifact'; item: Artifact; parentWorktree?: Worktree; parentBoard?: Board }
  | { type: 'board'; item: Board }
  | { type: 'mcp'; item: MCPServer };

export interface ResultsByType {
  session: SearchResultItem[];
  worktree: SearchResultItem[];
  assistant: SearchResultItem[];
  artifact: SearchResultItem[];
  board: SearchResultItem[];
  mcp: SearchResultItem[];
}

export const EMPTY_RESULTS: ResultsByType = {
  session: [],
  worktree: [],
  assistant: [],
  artifact: [],
  board: [],
  mcp: [],
};

/** Per-section cap in the dropdown — matches §3.4 of the design doc. */
export const SECTION_LIMIT = 5;

/** Cap when a single type chip is active and the section expands. */
export const SECTION_LIMIT_EXPANDED = 15;

/** Minimum query length before live results fire; below this we show recents. */
export const MIN_QUERY_LENGTH = 2;

/** Debounce on input change before recomputing results. */
export const SEARCH_DEBOUNCE_MS = 220;
