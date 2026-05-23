import type { Artifact, Board, MCPServer, Session, Worktree } from '@agor-live/client';

export type SearchEntityType = 'session' | 'worktree' | 'assistant' | 'artifact' | 'board' | 'mcp';

export type ChipFilter = 'all' | SearchEntityType;

/**
 * Canonical render/iteration order for entity-type sections in the dropdown.
 * Shared between the keyboard-nav flattener in `GlobalSearch.tsx` and the
 * section renderer in `GlobalSearchDropdown.tsx` so the visible row order
 * cannot drift from the cursor index.
 */
export const SECTION_ORDER: SearchEntityType[] = [
  'session',
  'worktree',
  'assistant',
  'artifact',
  'board',
  'mcp',
];

export const TYPE_CHIP_ORDER: ChipFilter[] = [
  'all',
  'session',
  'worktree',
  'assistant',
  'artifact',
  'board',
  'mcp',
];

/**
 * Chip labels intentionally use the singular ("Session" / "Worktree") so the
 * Segmented control fits the 480px dropdown without wrapping. Section headers
 * in the dropdown body keep the plural ("Sessions · 5") since they sit on
 * their own line with a count beside them.
 */
export const TYPE_CHIP_LABELS: Record<ChipFilter, string> = {
  all: 'All',
  session: 'Session',
  worktree: 'Worktree',
  assistant: 'Assistant',
  artifact: 'Artifact',
  board: 'Board',
  mcp: 'MCP',
};

/** Plural section-header labels for the dropdown body (e.g. "Sessions · 5"). */
export const SECTION_LABELS: Record<SearchEntityType, string> = {
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
  | { type: 'session'; item: Session; parentWorktree?: Worktree }
  | { type: 'worktree'; item: Worktree }
  | { type: 'assistant'; item: Worktree }
  | { type: 'artifact'; item: Artifact; parentWorktree?: Worktree }
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
