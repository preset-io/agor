import type {
  BoardEntityType,
  BoardObjectType,
  BoardPosition,
  LayoutDensityPolicy,
  ZoneLayoutBinding,
  ZoneLayoutPolicy,
  ZoneLayoutPreset,
  ZoneLayoutSortBy,
  ZoneLayoutSortDirection,
  ZoneOverflowStrategy,
  ZoneResizeMode,
} from '../types/board';
import type { Card } from '../types/card';
import { BOARD_GRID_SIZE, ceilBoardGridValue, snapBoardGridValue } from './rectangle-packing';

export const ZONE_LAYOUT_MODES = ['manual', 'auto'] as const;
export const ZONE_LAYOUT_PRESETS = ['grid', 'compact_list'] as const;
export const LAYOUT_DENSITY_POLICIES = ['preserve', 'expand', 'collapse'] as const;
export const ZONE_LAYOUT_SORT_FIELDS = [
  'position',
  'priority',
  'status',
  'updated',
  'created',
  'title',
] as const;
export const ZONE_LAYOUT_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const ZONE_RESIZE_MODES = ['fixed', 'height', 'both'] as const;
export const ZONE_OVERFLOW_STRATEGIES = ['report', 'reflow_board'] as const;
export const ZONE_CONTENT_JUSTIFICATIONS = [
  'left',
  'middle',
  'right',
  'top',
  'vertical_middle',
  'bottom',
] as const;
export type ZoneContentJustification = (typeof ZONE_CONTENT_JUSTIFICATIONS)[number];

/** Shared user-facing names for the persisted zone layout vocabulary. */
export const ZONE_LAYOUT_PRESET_LABELS: Readonly<Record<ZoneLayoutPreset, string>> = {
  grid: 'Grid',
  compact_list: 'List',
};

export const LAYOUT_DENSITY_POLICY_LABELS: Readonly<Record<LayoutDensityPolicy, string>> = {
  preserve: 'Preserve current expansion',
  expand: 'Expand eligible contents',
  collapse: 'Collapse eligible contents',
};

export const ZONE_LAYOUT_SORT_LABELS: Readonly<Record<ZoneLayoutSortBy, string>> = {
  position: 'Current position',
  priority: 'Priority / rank',
  status: 'Workflow status',
  updated: 'Last updated',
  created: 'Created',
  title: 'Title',
};

export const ZONE_LAYOUT_SORT_DIRECTION_LABELS: Readonly<
  Record<ZoneLayoutSortBy, Readonly<Record<ZoneLayoutSortDirection, string>>>
> = {
  position: { asc: 'Top-left first', desc: 'Bottom-right first' },
  priority: { asc: 'Highest first', desc: 'Lowest first' },
  status: { asc: 'Urgent to done', desc: 'Done to urgent' },
  updated: { asc: 'Oldest first', desc: 'Newest first' },
  created: { asc: 'Oldest first', desc: 'Newest first' },
  title: { asc: 'A to Z', desc: 'Z to A' },
};

export const ZONE_OVERFLOW_STRATEGY_LABELS: Readonly<Record<ZoneOverflowStrategy, string>> = {
  report: 'Report overflow',
  reflow_board: 'Move neighboring zones',
};

export function defaultZoneLayoutSortDirection(sortBy: ZoneLayoutSortBy): ZoneLayoutSortDirection {
  return sortBy === 'updated' || sortBy === 'created' ? 'desc' : 'asc';
}

export function zoneLayoutSortDirectionOptions(sortBy: ZoneLayoutSortBy) {
  const labels = ZONE_LAYOUT_SORT_DIRECTION_LABELS[sortBy];
  const preferred = defaultZoneLayoutSortDirection(sortBy);
  const directions = [
    preferred,
    ...ZONE_LAYOUT_SORT_DIRECTIONS.filter((value) => value !== preferred),
  ];
  return directions.map((value) => ({ value, label: labels[value] }));
}

/**
 * Board entity kinds which can own a real secondary-density state.
 *
 * A branch/worktree card owns collapsible session and environment content.
 * A generic card owns that state only while it has a rendered description or
 * note body. Artifacts, notes, and apps do not share that contract; writing
 * `compact` for them would only manufacture an inert control/state.
 * Keep this runtime capability beside the shared layout policy so browser,
 * daemon, and MCP callers cannot drift into different target sets.
 */
export const BOARD_DENSITY_EXPANDABLE_ENTITY_TYPES = [
  'branch',
  'card',
] as const satisfies readonly BoardEntityType[];

export type BoardDensityExpandableEntityType =
  (typeof BOARD_DENSITY_EXPANDABLE_ENTITY_TYPES)[number];

/** Every persisted board surface kind that callers may ask about. */
export type BoardDensitySurfaceKind = BoardEntityType | BoardObjectType;

export type CardDensityContent = Pick<Card, 'description' | 'note'>;

/**
 * One board-space sizing contract for the generic CardNode surface.
 *
 * Keep this independent of canvas zoom: React Flow scales board space as a
 * whole, while a viewport-responsive cap would change the measured node size
 * merely because one collaborator zoomed and could make Auto Zone oscillate.
 * The lower body is therefore capped at a readable fraction of the standard
 * card width and becomes an accessible internal scroll region. UI rendering
 * and non-visual planners both consume these values.
 */
export const GENERIC_BOARD_CARD_LAYOUT = {
  width: 380,
  minHeight: 56,
  headerEstimatedHeight: 50,
  bodyMaxHeight: 320,
  descriptionPreviewChars: 100,
  estimatedCharsPerLine: 48,
  estimatedLineHeight: 18,
  sectionVerticalPadding: 16,
  descriptionMoreHeight: 18,
} as const;

export function estimateExpandedGenericCardHeight(
  card: CardDensityContent | null | undefined
): number {
  const lineCount = (value: string | null | undefined) =>
    value
      ? Math.max(1, Math.ceil(value.length / GENERIC_BOARD_CARD_LAYOUT.estimatedCharsPerLine))
      : 0;
  const description = card?.description
    ? GENERIC_BOARD_CARD_LAYOUT.sectionVerticalPadding +
      lineCount(card.description.slice(0, GENERIC_BOARD_CARD_LAYOUT.descriptionPreviewChars)) *
        GENERIC_BOARD_CARD_LAYOUT.estimatedLineHeight +
      (card.description.length > GENERIC_BOARD_CARD_LAYOUT.descriptionPreviewChars
        ? GENERIC_BOARD_CARD_LAYOUT.descriptionMoreHeight
        : 0)
    : 0;
  const note = card?.note
    ? GENERIC_BOARD_CARD_LAYOUT.sectionVerticalPadding +
      lineCount(card.note) * GENERIC_BOARD_CARD_LAYOUT.estimatedLineHeight
    : 0;
  const boundedBody = Math.min(GENERIC_BOARD_CARD_LAYOUT.bodyMaxHeight, description + note);
  return Math.max(
    GENERIC_BOARD_CARD_LAYOUT.minHeight,
    GENERIC_BOARD_CARD_LAYOUT.headerEstimatedHeight + boundedBody
  );
}

/** Whether CardNode renders a lower section which compact mode can hide. */
export function hasCardDensityBody(
  card: CardDensityContent | null | undefined
): card is CardDensityContent {
  return Boolean(card?.description || card?.note);
}

export function isBoardEntityDensityExpandable(
  entityType: BoardDensitySurfaceKind,
  card?: CardDensityContent | null
): entityType is BoardDensityExpandableEntityType {
  return entityType === 'branch' || (entityType === 'card' && hasCardDensityBody(card));
}

export type NormalizedZoneLayoutPolicy = ZoneLayoutPolicy & { density: LayoutDensityPolicy };

export const DEFAULT_ZONE_LAYOUT_POLICY: Readonly<NormalizedZoneLayoutPolicy> = {
  mode: 'manual',
  preset: 'grid',
  density: 'preserve',
  sortBy: 'position',
  sortDirection: 'asc',
  autoResizeHeight: false,
  resize: 'fixed',
  onOverflow: 'report',
  gap: 24,
};

/** Resolve a requested density without manufacturing state for incapable surfaces. */
export function layoutCompactTarget(
  policy: LayoutDensityPolicy,
  current: boolean | undefined,
  densityExpandable: boolean
): boolean | undefined {
  if (!densityExpandable || policy === 'preserve') return current;
  return policy === 'collapse';
}

/**
 * Legacy zones are explicit overrides. This fail-closed default is what lets
 * boards adopt a shared policy without silently rewriting old zone behavior.
 */
export function zoneLayoutBinding(
  zone: { layout_binding?: ZoneLayoutBinding } | null | undefined
): ZoneLayoutBinding {
  return zone?.layout_binding === 'inherit' ? 'inherit' : 'override';
}

/** Resolve a zone through the same normalizer used by UI, daemon, and MCP. */
export function resolveZoneLayoutPolicy(
  zone: { layout?: Partial<ZoneLayoutPolicy>; layout_binding?: ZoneLayoutBinding },
  boardDefaults?: Partial<ZoneLayoutPolicy>
): NormalizedZoneLayoutPolicy {
  return normalizeZoneLayoutPolicy(
    zoneLayoutBinding(zone) === 'inherit' ? boardDefaults : zone.layout
  );
}

export const ZONE_LAYOUT_FRAME_PADDING = BOARD_GRID_SIZE;

/**
 * Auto-resize is deliberately grow-only. A direct zone resize establishes the
 * user's new minimum frame while leaving future content growth armed.
 */
export function growZoneLayoutHeight(currentHeight: number, requiredHeight: number): number {
  return Math.max(currentHeight, 200, ceilBoardGridValue(requiredHeight));
}

export interface ZoneLayoutFrameInput {
  width: number;
  fontSize?: number;
  status?: string;
}

export interface ZoneLayoutFrameOptions {
  padding?: number;
  /**
   * Converts screen-stable title text into board-space geometry. Browsers pass
   * the inverse canvas zoom; non-visual callers use the stable default of 1.
   */
  fontScale?: number;
}

export interface ZoneLayoutFrame {
  /** Grid-aligned outer width used by the layout solver. */
  width: number;
  /** Equal left/right and bottom inset for every child entity type. */
  padding: number;
  /** Reserved title/status area before the first child. */
  headerInset: number;
  /** Width available to a full-width compact-list child. */
  usableWidth: number;
}

export interface ZoneContentRect extends BoardPosition {
  id: string;
  width: number;
  height: number;
}

export interface JustifiedZoneContents {
  fits: boolean;
  placements: ZoneContentRect[];
}

const JUSTIFY_OVERLAP_TOLERANCE = 0.5;

function connectedSpanComponents(
  items: readonly ZoneContentRect[],
  span: 'horizontal' | 'vertical'
): number[][] {
  const start = (item: ZoneContentRect) => (span === 'horizontal' ? item.x : item.y);
  const end = (item: ZoneContentRect) =>
    start(item) + (span === 'horizontal' ? item.width : item.height);
  const overlaps = (left: ZoneContentRect, right: ZoneContentRect) =>
    Math.min(end(left), end(right)) - Math.max(start(left), start(right)) >
    JUSTIFY_OVERLAP_TOLERANCE;
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        start(left.item) - start(right.item) ||
        end(left.item) - end(right.item) ||
        left.item.id.localeCompare(right.item.id)
    );
  const remaining = new Set(ordered.map(({ index }) => index));
  const components: number[][] = [];

  for (const { index: seed } of ordered) {
    if (!remaining.delete(seed)) continue;
    const component = [seed];
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      const current = component[cursor];
      for (const { index: candidate } of ordered) {
        if (!remaining.has(candidate) || !overlaps(items[current], items[candidate])) continue;
        remaining.delete(candidate);
        component.push(candidate);
      }
    }
    components.push(component);
  }
  return components;
}

/**
 * Align collision-independent rows or columns inside a zone frame. Horizontal
 * actions translate connected components whose vertical spans overlap; top
 * and vertical actions translate components whose horizontal spans overlap. Each
 * component remains a rigid body, so collision-free geometry stays
 * collision-free while separate rows/columns can align independently.
 * `middle` retains its public horizontal-centering meaning;
 * `vertical_middle` is the matching vertical-centering action.
 */
export function justifyZoneContentCluster(
  items: readonly ZoneContentRect[],
  frame: ZoneLayoutFrame,
  zoneHeight: number,
  justification: ZoneContentJustification
): JustifiedZoneContents {
  if (items.length === 0) return { fits: true, placements: [] };

  const contentLeft = frame.padding;
  const contentRight = frame.width - frame.padding;
  const contentTop = frame.headerInset + frame.padding;
  const contentBottom = zoneHeight - frame.padding;
  const horizontal =
    justification === 'left' || justification === 'middle' || justification === 'right';
  const components = connectedSpanComponents(items, horizontal ? 'vertical' : 'horizontal');
  const placements = items.map((item) => ({ ...item }));

  for (const component of components) {
    const componentItems = component.map((index) => items[index]);
    const start = horizontal
      ? Math.min(...componentItems.map((item) => item.x))
      : Math.min(...componentItems.map((item) => item.y));
    const end = horizontal
      ? Math.max(...componentItems.map((item) => item.x + item.width))
      : Math.max(...componentItems.map((item) => item.y + item.height));
    // Top alignment and automatic packing reserve the title/status header.
    // Explicit vertical centering, however, targets the geometric center of
    // the zone itself; a taller title must never bias the contents downward.
    const contentStart = horizontal
      ? contentLeft
      : justification === 'vertical_middle'
        ? frame.padding
        : contentTop;
    const contentEnd = horizontal ? contentRight : contentBottom;
    if (end - start > contentEnd - contentStart + JUSTIFY_OVERLAP_TOLERANCE) {
      return { fits: false, placements: [...items] };
    }

    const targetStart =
      justification === 'right' || justification === 'bottom'
        ? contentEnd - (end - start)
        : justification === 'middle' || justification === 'vertical_middle'
          ? (contentStart + contentEnd - (end - start)) / 2
          : contentStart;
    const delta = snapBoardGridValue(targetStart - start);
    for (const index of component) {
      if (horizontal) placements[index].x += delta;
      else placements[index].y += delta;
    }
  }

  return {
    fits: true,
    placements,
  };
}

/**
 * One frame contract for every zone layout path and child entity type.
 *
 * The frame is intentionally independent of the card/worktree inside it:
 * layout configuration and zone metadata own its margins and title reserve.
 */
export function getZoneLayoutFrame(
  zone: ZoneLayoutFrameInput,
  options: ZoneLayoutFrameOptions = {}
): ZoneLayoutFrame {
  const requestedPadding = options.padding ?? ZONE_LAYOUT_FRAME_PADDING;
  const padding =
    requestedPadding === 0
      ? 0
      : Math.max(BOARD_GRID_SIZE, ceilBoardGridValue(Math.max(0, requestedPadding)));
  const requestedWidth =
    Number.isFinite(zone.width) && zone.width > 0 ? zone.width : padding * 2 + BOARD_GRID_SIZE;
  const width = Math.max(padding * 2 + BOARD_GRID_SIZE, ceilBoardGridValue(requestedWidth));
  const labelFontSize =
    typeof zone.fontSize === 'number' && Number.isFinite(zone.fontSize)
      ? Math.min(48, Math.max(10, zone.fontSize))
      : 14;
  const fontScale =
    typeof options.fontScale === 'number' && Number.isFinite(options.fontScale)
      ? Math.min(10, Math.max(0.1, options.fontScale))
      : 1;
  const labelHeight = Math.ceil(labelFontSize * fontScale * 1.2);
  const statusHeight = zone.status
    ? Math.ceil(8 * fontScale) + Math.ceil(labelFontSize * fontScale * 1.05)
    : 0;
  const headerInset = ceilBoardGridValue(Math.max(64, 32 + labelHeight + statusHeight));

  return {
    width,
    padding,
    headerInset,
    usableWidth: width - padding * 2,
  };
}

/** Compact-list children share the frame width; only their content height differs. */
export function compactZoneItemSize(
  entityType: BoardEntityType,
  usableWidth: number
): { width: number; height: number } {
  return {
    width: usableWidth,
    height: entityType === 'branch' ? BOARD_GRID_SIZE * 5 : BOARD_GRID_SIZE * 3,
  };
}

export interface ZoneLayoutSortItem {
  id: string;
  position: BoardPosition;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Numeric ranks sort naturally; lower values represent higher priority. */
  rank?: number;
  /** Common workflow labels such as urgent, high, blocked, done, or archived. */
  priority?: unknown;
  status?: unknown;
}

const isOneOf = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === 'string' && values.includes(value as T);

export function normalizeZoneLayoutPolicy(
  policy: Partial<ZoneLayoutPolicy> | undefined
): NormalizedZoneLayoutPolicy {
  const preset: ZoneLayoutPreset = isOneOf(policy?.preset, ZONE_LAYOUT_PRESETS)
    ? policy.preset
    : DEFAULT_ZONE_LAYOUT_POLICY.preset;
  const sortBy: ZoneLayoutSortBy = isOneOf(policy?.sortBy, ZONE_LAYOUT_SORT_FIELDS)
    ? policy.sortBy
    : DEFAULT_ZONE_LAYOUT_POLICY.sortBy;
  const sortDirection: ZoneLayoutSortDirection = isOneOf(
    policy?.sortDirection,
    ZONE_LAYOUT_SORT_DIRECTIONS
  )
    ? policy.sortDirection
    : DEFAULT_ZONE_LAYOUT_POLICY.sortDirection;
  const density: LayoutDensityPolicy = isOneOf(policy?.density, LAYOUT_DENSITY_POLICIES)
    ? policy.density
    : DEFAULT_ZONE_LAYOUT_POLICY.density;
  const columns =
    Number.isFinite(policy?.columns) && (policy?.columns ?? 0) > 0
      ? Math.max(1, Math.floor(policy?.columns ?? 1))
      : undefined;
  const gap = Number.isFinite(policy?.gap)
    ? Math.min(96, Math.max(0, Math.round(policy?.gap ?? 24)))
    : DEFAULT_ZONE_LAYOUT_POLICY.gap;

  // `resize` supersedes the `autoResizeHeight` boolean. Reconciling them here,
  // once, is what keeps every caller from having to know both spellings: an
  // explicit `resize` wins, an old policy is read through its boolean, and both
  // are always written back so a reader predating `resize` still behaves.
  const resize: ZoneResizeMode = isOneOf(policy?.resize, ZONE_RESIZE_MODES)
    ? policy.resize
    : policy?.autoResizeHeight === true
      ? 'height'
      : 'fixed';
  const onOverflow: ZoneOverflowStrategy = isOneOf(policy?.onOverflow, ZONE_OVERFLOW_STRATEGIES)
    ? policy.onOverflow
    : 'report';

  return {
    mode: isOneOf(policy?.mode, ZONE_LAYOUT_MODES) ? policy.mode : DEFAULT_ZONE_LAYOUT_POLICY.mode,
    preset,
    density,
    sortBy,
    sortDirection,
    ...(columns === undefined ? {} : { columns }),
    gap,
    resize,
    onOverflow,
    autoResizeHeight: resize !== 'fixed',
  };
}

/**
 * Change only Auto Zone's maintenance mode while preserving the complete
 * normalized policy. Enabling automation from the spatial-memory default uses
 * newest activity rather than continually treating freshly persisted layout
 * coordinates as new sort input. UI toolbar, modal, and MCP callers share this
 * transition so an enable action cannot acquire surface-specific defaults.
 */
export function setZoneLayoutMode(
  policy: Partial<ZoneLayoutPolicy> | undefined,
  mode: ZoneLayoutPolicy['mode']
): NormalizedZoneLayoutPolicy {
  const current = normalizeZoneLayoutPolicy(policy);
  if (current.mode === mode) return current;
  if (mode === 'auto' && current.sortBy === 'position') {
    return {
      ...current,
      mode,
      sortBy: 'updated',
      sortDirection: defaultZoneLayoutSortDirection('updated'),
    };
  }
  return { ...current, mode };
}

const PRIORITY_RANKS: Readonly<Record<string, number>> = {
  urgent: 0,
  critical: 0,
  highest: 0,
  high: 1,
  blocked: 1,
  medium: 2,
  normal: 2,
  low: 3,
  lowest: 4,
  done: 5,
  completed: 5,
  archived: 6,
};

const STATUS_RANKS: Readonly<Record<string, number>> = {
  urgent: 0,
  blocked: 1,
  failed: 1,
  error: 1,
  // Branch filesystem lifecycle values. Keep these here alongside workflow
  // statuses because branch and card placements share the public status sort.
  creating: 2,
  running: 2,
  active: 2,
  ready: 3,
  todo: 3,
  open: 3,
  pending: 3,
  review: 4,
  preserved: 4,
  done: 5,
  completed: 5,
  closed: 5,
  cleaned: 5,
  archived: 6,
  deleted: 6,
};

function normalizedLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function semanticRank(value: unknown, ranks: Readonly<Record<string, number>>): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const label = normalizedLabel(value);
  if (!label) return Number.POSITIVE_INFINITY;
  return ranks[label] ?? 50;
}

function timestamp(value: string | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function compareNumber(a: number, b: number): number {
  if (a === b) return 0;
  if (!Number.isFinite(a)) return 1;
  if (!Number.isFinite(b)) return -1;
  return a - b;
}

function compareText(a: unknown, b: unknown): number {
  const left = normalizedLabel(a);
  const right = normalizedLabel(b);
  if (!left && right) return 1;
  if (left && !right) return -1;
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
}

function compareField(a: ZoneLayoutSortItem, b: ZoneLayoutSortItem, sortBy: ZoneLayoutSortBy) {
  switch (sortBy) {
    case 'position':
      return a.position.y - b.position.y || a.position.x - b.position.x;
    case 'priority':
      return compareNumber(
        a.rank ?? semanticRank(a.priority, PRIORITY_RANKS),
        b.rank ?? semanticRank(b.priority, PRIORITY_RANKS)
      );
    case 'status':
      return (
        compareNumber(semanticRank(a.status, STATUS_RANKS), semanticRank(b.status, STATUS_RANKS)) ||
        compareText(a.status, b.status)
      );
    case 'updated':
      return compareNumber(timestamp(a.updatedAt), timestamp(b.updatedAt));
    case 'created':
      return compareNumber(timestamp(a.createdAt), timestamp(b.createdAt));
    case 'title':
      return compareText(a.title, b.title);
  }
}

function isMissingSortValue(item: ZoneLayoutSortItem, sortBy: ZoneLayoutSortBy): boolean {
  if (sortBy === 'priority') {
    if (item.rank !== undefined && Number.isFinite(item.rank)) return false;
    const label = normalizedLabel(item.priority);
    return !label || !(label in PRIORITY_RANKS);
  }
  if (sortBy === 'status') {
    const label = normalizedLabel(item.status);
    return !label || !(label in STATUS_RANKS);
  }
  if (sortBy === 'updated') return !Number.isFinite(Date.parse(item.updatedAt ?? ''));
  if (sortBy === 'created') return !Number.isFinite(Date.parse(item.createdAt ?? ''));
  if (sortBy === 'title') return !normalizedLabel(item.title);
  return false;
}

/** Deterministically order zone items while keeping missing metadata at the end. */
export function sortZoneLayoutItems<T extends ZoneLayoutSortItem>(
  items: readonly T[],
  policy: Pick<ZoneLayoutPolicy, 'sortBy' | 'sortDirection'>
): T[] {
  const direction = policy.sortDirection === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const comparison = compareField(a, b, policy.sortBy);
    // Missing values remain last in both directions instead of jumping to the
    // front when descending order is requested.
    const aMissing = isMissingSortValue(a, policy.sortBy);
    const bMissing = isMissingSortValue(b, policy.sortBy);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;

    // A semantic field is often shared (or absent) across heterogeneous
    // children. Falling straight through to an always-ascending opaque ID made
    // direction changes appear to do nothing on real boards. Titles provide a
    // visible, stable secondary key; IDs are the final total-order fence. Apply
    // direction to the complete logical ordering while still keeping missing
    // primary values in the final group above.
    const titleTieBreak = policy.sortBy === 'title' ? 0 : compareText(a.title, b.title);
    const idTieBreak = a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
    return (comparison || titleTieBreak || idTieBreak) * direction;
  });
}
