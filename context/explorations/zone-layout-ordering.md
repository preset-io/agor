# Zone Layout & Ordering

**Status:** Exploration (future PR)
**Related:** Cards system, board zones, React Flow canvas

---

## Problem

The current jitter-based placement system works for loose, large zones but breaks down in tight kanban-style boards. Items overlap randomly, and there's no concept of ordering within a zone.

## Current State

- **Jitter placement**: Random position within zone bounds minus padding
- **No awareness of existing items**: New items may overlap existing ones
- **No ordering**: Items have no `order` field, so re-rendering can shuffle visual order
- **Positions are relative** to zone origin when pinned to a zone

### Card Dimensions (Fixed)

Cards use fixed React Flow node dimensions:
- `width: 380`, `height: 120` (in SessionCanvas node creation)
- Visual content can overflow (description expand, notes), but layout math uses fixed dims
- **Key constraint**: Cards default to collapsed state on page load, so fixed height is reliable for layout

### Worktree Dimensions (Variable)

Worktrees are more complex:
- `width: 500`, `height: 200` (base estimate in SessionCanvas)
- Actual rendered height varies based on: number of sessions, expanded session trees, notes/markdown
- Could estimate with a `getWorktreeEstimatedHeight(worktree, sessions)` function that accounts for session count and whether notes exist

---

## Recommended Approach: Smart Stacking + Reorganize

**Don't fight React Flow's free-form nature.** Make initial placement and reorganization smart, but let users drag wherever they want.

### 1. Smart `setInZone()` Placement

Instead of random jitter, scan existing items in the zone and find the next open vertical slot:

```typescript
function getNextSlotPosition(
  zone: ZoneBoardObject,
  existingItems: BoardEntityObject[],
  itemHeight: number,
  gap: number = 20,
  padding: number = 40
): { x: number; y: number } {
  // Sort existing items by Y position
  const sorted = existingItems
    .filter(bo => bo.zone_id === zoneId)
    .sort((a, b) => a.position.y - b.position.y);

  // Find next Y slot after last item
  const lastY = sorted.length > 0
    ? sorted[sorted.length - 1].position.y + itemHeight + gap
    : padding;

  // Center horizontally in zone
  const centerX = Math.max(padding, (zone.width - itemWidth) / 2);

  return { x: centerX, y: lastY };
}
```

**Fallback to jitter** when the zone is too full (next slot would exceed zone height).

### 2. `order` Field on `board_objects`

Add an integer `order` column to `board_objects`:
- Nullable (backward compat — null means "no explicit order")
- Used by `reorganizeZone()` for deterministic stacking
- Set automatically on placement (max existing order + 1)
- Updated on reorder operations

```sql
ALTER TABLE board_objects ADD COLUMN "order" INTEGER;
```

### 3. `reorganizeZone()` API + MCP Tool

A "tidy up" action that re-stacks all items in a zone vertically:

```typescript
async reorganizeZone(boardId: BoardID, zoneId: string): Promise<void> {
  const items = await boardObjectRepo.findByZoneId(boardId, zoneId);
  const sorted = items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  let currentY = PADDING;
  for (const item of sorted) {
    const height = item.card_id ? CARD_HEIGHT : getWorktreeEstimatedHeight(item);
    await boardObjectRepo.update(item.object_id, {
      position: { x: CENTER_X, y: currentY },
      order: sorted.indexOf(item),
    });
    currentY += height + GAP;
  }
}
```

**MCP tool**: `agor_boards_reorganize_zone` — agents can call after bulk card operations.

### 4. UI "Tidy" Button on Zones

Small button in zone header (next to label) that calls `reorganizeZone()`. Gives users a one-click cleanup.

---

## Height Estimation Strategy

### Cards: Fixed Height

Cards use fixed `CARD_HEIGHT = 120` for layout calculations:
- Title + emoji + icons = ~45px
- Description (collapsed, max 100 chars) = ~35px
- Note (first ~2 lines) = ~40px
- Cards render in collapsed state by default; user expansion causes acceptable overlap
- Page refresh resets to collapsed = clean layout

### Worktrees: Estimated Height

```typescript
function getWorktreeEstimatedHeight(
  worktree: Worktree,
  sessions: Session[]
): number {
  const BASE_HEIGHT = 120; // Header + repo info
  const SESSION_ROW_HEIGHT = 32;
  const NOTES_HEIGHT = worktree.notes ? 60 : 0;

  const sessionCount = Math.min(sessions.length, 5); // Cap at 5 visible
  return BASE_HEIGHT + sessionCount * SESSION_ROW_HEIGHT + NOTES_HEIGHT;
}
```

---

## Rejected Approaches

### DnD Toolkit (dnd-kit / react-beautiful-dnd)

React Flow manages its own drag system (transforms, zoom, panning) via an internal coordinate space. External DnD libraries operate in screen/DOM coordinates. Two drag systems fighting over the same mouse events — one for free-form canvas, one for list reordering — creates ambiguous "is this a reorder or a canvas move?" behavior. Not worth the complexity.

### Strict Ordered List Mode (`isZoneOrderedList`)

Would require:
- Custom collision detection parallel to React Flow's
- Position recalculation on every drag
- Zone auto-resize as items reorder
- 6-8 hours of fragile code fighting the tool

The smart stacking + reorganize approach gives 90% of kanban value with 20% of the effort.

### Forced Static Height for All Items

Constraining all cards/worktrees to identical height wastes space on simple items and truncates rich ones. Fights the "cards are visual feedback" philosophy — agents write variable-length notes, and hiding content defeats the purpose.

---

## Implementation Plan (Future PR)

1. **Schema**: Add `order` column to `board_objects` (migration)
2. **Smart placement**: Update `createWithPlacement` and `moveToZone` to use slot calculation
3. **Reorganize service**: `CardsService.reorganizeZone()` method
4. **MCP tool**: `agor_boards_reorganize_zone`
5. **UI button**: Tidy button in zone header
6. **Height estimation**: `getWorktreeEstimatedHeight()` utility

---

## Open Questions

- Should `reorganizeZone()` respect a sort order (by title, by created_at, by order)?
- Should zones auto-resize height when items overflow?
- Should the tidy button be visible always or only on zone hover?
- Worth adding a "compact" zone mode that uses smaller card rendering?
