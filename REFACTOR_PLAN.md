# Map-Based Architecture Refactor Plan

## Overview

This document outlines the systematic migration of all consumer components from array-based to Map-based data access patterns following the `useAgorData` refactor.

## Refactor Status

- ✅ **Phase 1**: Core infrastructure (useAgorData + mapHelpers) - COMPLETE
- 🔄 **Phase 2**: Consumer components migration - IN PROGRESS
- ⏳ **Phase 3**: Testing and validation - PENDING

---

## Migration Pattern

### Before (Array-based)

```typescript
const { boards, repos, users } = useAgorData(client);

// Direct array operations
const myBoard = boards.find(b => b.board_id === id);
const sortedRepos = repos.sort((a, b) => a.name.localeCompare(b.name));
const adminUsers = users.filter(u => u.role === 'admin');
```

### After (Map-based)

```typescript
import { mapToArray, filterMap } from '@/utils/mapHelpers';

const { boardById, repoById, userById } = useAgorData(client);

// O(1) lookup by ID
const myBoard = boardById.get(id);

// Convert to array for rendering
const sortedRepos = mapToArray(repoById).sort((a, b) => a.name.localeCompare(b.name));

// Filter helper
const adminUsers = filterMap(userById, u => u.role === 'admin');
```

---

## File-by-File Migration Checklist

### Phase 2A: Core App Components (High Priority)

- [ ] **apps/agor-ui/src/App.tsx** (main app entry)
  - Update destructuring: `boards` → `boardById`, etc.
  - Fix `users.find()` on line 170
  - Fix `comments` usage on line 886

- [ ] **apps/agor-ui/src/components/App/App.tsx** (if different from above)
  - Update all Map references

### Phase 2B: Board-Related Components

- [ ] **apps/agor-ui/src/hooks/useBoardActions.ts**
  - Update board access patterns

- [ ] **apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx**
  - Update boards, comments access
  - Critical for markdown fix!

- [ ] **apps/agor-ui/src/components/SessionCanvas/canvas/useBoardObjects.ts**
  - Update board objects access

- [ ] **apps/agor-ui/src/components/SettingsModal/BoardsTable.tsx**
  - Convert boards array to Map

- [ ] **apps/agor-ui/src/components/WorktreeModal/tabs/GeneralTab.tsx**
  - Update boards access

- [ ] **apps/agor-ui/src/components/WorktreeFormFields/WorktreeFormFields.tsx**
  - Update boards access

- [ ] **apps/agor-ui/src/components/WorktreeListDrawer/WorktreeListDrawer.tsx**
  - Update boards access

- [ ] **apps/agor-ui/src/components/CommentsPanel/CommentsPanel.tsx**
  - Update comments access

### Phase 2C: Repo-Related Components

- [ ] **apps/agor-ui/src/components/NewWorktreeModal/NewWorktreeModal.tsx**
  - Update repos access (3 usages)

- [ ] **apps/agor-ui/src/components/SettingsModal/ReposTable.tsx**
  - Convert repos array to Map

- [ ] **apps/agor-ui/src/components/SettingsModal/WorktreesTable.tsx**
  - Update repos access (6 usages)

- [ ] **apps/agor-ui/src/components/WorktreeFormFields/WorktreeFormFields.tsx**
  - Update repos access

- [ ] **apps/agor-ui/src/components/SessionDrawer/SessionDrawer.tsx**
  - Update repos access

### Phase 2D: User-Related Components (31 files)

- [ ] **apps/agor-ui/src/components/SettingsModal/UsersTable.tsx**
  - Convert users array to Map

- [ ] **apps/agor-ui/src/components/Facepile/Facepile.tsx**
  - Update users access

- [ ] **apps/agor-ui/src/components/metadata/CreatedByTag.tsx**
  - Update users access for lookups

- [ ] **apps/agor-ui/src/components/SessionCard/SessionCard.tsx**
  - Update users access

- [ ] **apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx**
  - Update users access

- [ ] **apps/agor-ui/src/components/ConversationView/ConversationView.tsx**
  - Update users access

- [ ] **apps/agor-ui/src/components/MessageBlock/MessageBlock.tsx**
  - Update users access

- [ ] **apps/agor-ui/src/components/TaskBlock/TaskBlock.tsx**
  - Update users access

- [ ] **apps/agor-ui/src/components/AutocompleteTextarea/AutocompleteTextarea.tsx**
  - Update users access for @ mentions

- [ ] **apps/agor-ui/src/hooks/usePresence.ts**
  - Update users access

- [ ] **apps/agor-ui/src/hooks/useCursorTracking.ts**
  - Update users access

- [ ] (Additional 20 user-related files)

### Phase 2E: MCP Server Components

- [ ] **apps/agor-ui/src/components/SettingsModal/MCPServersTable.tsx**
  - Convert mcpServers array to Map

- [ ] **apps/agor-ui/src/components/MCPServerSelect/MCPServerSelect.tsx**
  - Update mcpServers access

- [ ] **apps/agor-ui/src/components/NewSessionModal/NewSessionModal.tsx**
  - Update mcpServers access

- [ ] **apps/agor-ui/src/components/ForkSpawnModal/ForkSpawnModal.tsx**
  - Update mcpServers access

- [ ] **apps/agor-ui/src/components/SessionSettingsModal/SessionSettingsModal.tsx**
  - Update mcpServers access

- [ ] (Additional 11 MCP-related files)

### Phase 2F: Mobile Components

- [ ] **apps/agor-ui/src/components/mobile/MobileApp.tsx**
  - Update all Map references

- [ ] **apps/agor-ui/src/components/mobile/MobileNavTree.tsx**
  - Update boards access

- [ ] **apps/agor-ui/src/components/mobile/MobileCommentsPage.tsx**
  - Update boards, comments, users access

- [ ] **apps/agor-ui/src/components/mobile/SessionPage.tsx**
  - Update repos, boards, users access

### Phase 2G: Settings & Configuration

- [ ] **apps/agor-ui/src/components/SettingsModal/SettingsModal.tsx**
  - Update all Map references

- [ ] **apps/agor-ui/src/components/SettingsModal/DefaultAgenticSettings.tsx**
  - Update users, mcpServers access

- [ ] **apps/agor-ui/src/components/SettingsModal/AgenticToolsSection.tsx**
  - Update users access

- [ ] **apps/agor-ui/src/components/SettingsModal/OpenCodeTab.tsx**
  - Update users access

---

## Common Migration Patterns

### Pattern 1: Direct ID Lookup

```typescript
// BEFORE
const user = users.find(u => u.user_id === userId);

// AFTER
const user = userById.get(userId);
```

### Pattern 2: Render List

```typescript
// BEFORE
{boards.map(board => <BoardCard key={board.board_id} board={board} />)}

// AFTER
import { mapToArray } from '@/utils/mapHelpers';
{mapToArray(boardById).map(board => <BoardCard key={board.board_id} board={board} />)}
```

### Pattern 3: Filter + Map

```typescript
// BEFORE
const activeUsers = users.filter(u => u.status === 'active').map(u => u.name);

// AFTER
import { filterMap } from '@/utils/mapHelpers';
const activeUsers = filterMap(userById, u => u.status === 'active').map(u => u.name);
```

### Pattern 4: Sorted List

```typescript
// BEFORE
const sortedRepos = repos.sort((a, b) => a.name.localeCompare(b.name));

// AFTER
import { mapToSortedArray } from '@/utils/mapHelpers';
const sortedRepos = mapToSortedArray(repoById, (a, b) => a.name.localeCompare(b.name));
```

### Pattern 5: Find by Predicate

```typescript
// BEFORE
const adminUser = users.find(u => u.role === 'admin');

// AFTER
import { findInMap } from '@/utils/mapHelpers';
const adminUser = findInMap(userById, u => u.role === 'admin');
```

---

## Testing Checklist

After each phase, verify:

- [ ] No TypeScript errors (`pnpm typecheck`)
- [ ] No lint errors (`pnpm lint`)
- [ ] App builds successfully (`pnpm build`)
- [ ] UI renders correctly in browser
- [ ] No console errors during navigation
- [ ] Real-time updates work (WebSocket events)
- [ ] Markdown components stay visible (original bug fix!)

---

## Estimated Effort

- **Phase 2A** (Core): ~30 minutes
- **Phase 2B** (Boards): ~45 minutes
- **Phase 2C** (Repos): ~30 minutes
- **Phase 2D** (Users): ~90 minutes
- **Phase 2E** (MCP): ~45 minutes
- **Phase 2F** (Mobile): ~30 minutes
- **Phase 2G** (Settings): ~30 minutes

**Total**: ~4-5 hours

---

## Benefits After Completion

1. **Performance**: O(1) lookups instead of O(n) array scans
2. **Consistency**: Uniform Map-based pattern across all entities
3. **Stability**: Reference equality prevents unnecessary re-renders
4. **Scalability**: Handles large datasets efficiently
5. **Fix**: Resolves markdown disappearing bug via stable references

---

## Next Steps

1. Start with Phase 2A (App.tsx) - highest priority
2. Proceed through phases in order
3. Commit after each phase completes
4. Run tests after each phase
5. Create PR when all phases complete

---

_Last Updated: 2025-11-18_
_Status: Phase 1 Complete, Phase 2 Ready to Start_
