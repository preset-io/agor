import type { Artifact, Board, Branch, MCPServer, Session } from '@agor-live/client';

export type SearchEntityType = 'session' | 'branch' | 'teammate' | 'artifact' | 'board' | 'mcp';

export type ChipFilter = 'all' | SearchEntityType;

/**
 * Canonical render/iteration order for entity-type sections in the dropdown.
 * Shared between the keyboard-nav flattener in `GlobalSearch.tsx` and the
 * section renderer in `GlobalSearchDropdown.tsx` so the visible row order
 * cannot drift from the cursor index.
 */
export const SECTION_ORDER: SearchEntityType[] = [
  'session',
  'branch',
  'teammate',
  'artifact',
  'board',
  'mcp',
];

export const TYPE_CHIP_ORDER: ChipFilter[] = [
  'all',
  'session',
  'branch',
  'teammate',
  'artifact',
  'board',
  'mcp',
];

/**
 * Chip labels intentionally use the singular ("Session" / "Branch") so the
 * Segmented control fits the 480px dropdown without wrapping. Section headers
 * in the dropdown body use the plural form (see `SECTION_LABELS`).
 */
export const TYPE_CHIP_LABELS: Record<ChipFilter, string> = {
  all: 'All',
  session: 'Session',
  branch: 'Branch',
  teammate: 'Teammate',
  artifact: 'Artifact',
  board: 'Board',
  mcp: 'MCP',
};

/** Plural section-header labels for the dropdown body (e.g. "Sessions"). Per-
 * section counts are surfaced as badges on the chip row, not inline here. */
export const SECTION_LABELS: Record<SearchEntityType, string> = {
  session: 'Sessions',
  branch: 'Branches',
  teammate: 'Teammates',
  artifact: 'Artifacts',
  board: 'Boards',
  mcp: 'MCP',
};

export type SearchResultItem =
  | { type: 'session'; item: Session; parentBranch?: Branch }
  | { type: 'branch'; item: Branch }
  | { type: 'teammate'; item: Branch }
  | { type: 'artifact'; item: Artifact; parentBranch?: Branch }
  | { type: 'board'; item: Board }
  | { type: 'mcp'; item: MCPServer };

/** Narrowed result variant for a given entity type — keeps the union's
 * type discrimination intact when buckets are typed per section. */
export type SearchResultFor<T extends SearchEntityType> = Extract<SearchResultItem, { type: T }>;

/** Record keyed by every entity type. Used to share shape between
 * `ResultsByType` (rows) and `SearchCounts` (numbers). */
export type EntityRecord<T> = Record<SearchEntityType, T>;

/** Sectioned result buckets. Each bucket only contains rows of its own
 * entity type (TS-enforced via the mapped `SearchResultFor` extraction). */
export type ResultsByType = {
  [K in SearchEntityType]: SearchResultFor<K>[];
};

export const EMPTY_RESULTS: ResultsByType = {
  session: [],
  branch: [],
  teammate: [],
  artifact: [],
  board: [],
  mcp: [],
};

/**
 * Per-entity-type total match counts — used by the chip row to render badges
 * like "Branch (12)". Independent of `activeTypeChip` so an inactive chip
 * still surfaces "how many would I find if I clicked this." Pre-cap; the
 * `results` arrays are slice-limited per section while counts are not.
 */
export type SearchCounts = EntityRecord<number>;

export const EMPTY_COUNTS: SearchCounts = {
  session: 0,
  branch: 0,
  teammate: 0,
  artifact: 0,
  board: 0,
  mcp: 0,
};

/**
 * Live entity maps streamed by `useAgorData` (WebSocket-synced). Bundled into
 * one interface so the navbar component, the search hook, and the recents
 * hook can all consume the same shape via composition.
 */
export interface GlobalSearchEntityMaps {
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
  artifactById: Map<string, Artifact>;
  boardById: Map<string, Board>;
  mcpServerById: Map<string, MCPServer>;
}

/** Per-section cap in the dropdown — matches §3.4 of the design doc. */
export const SECTION_LIMIT = 5;

/** Cap when a single type chip is active and the section expands. */
export const SECTION_LIMIT_EXPANDED = 15;

/**
 * Cap per recents section. Smaller than `SECTION_LIMIT` because recents is
 * the at-rest empty-query view — six sections × 3 rows is already a
 * comfortable column of suggestions before the user has typed anything.
 */
export const RECENTS_SECTION_LIMIT = 3;

/** Minimum query length before live results fire; below this we show recents. */
export const MIN_QUERY_LENGTH = 2;

/** Debounce on input change before recomputing results. */
export const SEARCH_DEBOUNCE_MS = 220;
