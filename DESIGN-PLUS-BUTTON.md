# Design: Redesigned PLUS Button — "Start Here" Experience

## Current State

### The Plus Button
- **Component:** `NewSessionButton` (`apps/agor-ui/src/components/NewSessionButton/`)
- **Location:** Top-right of the board canvas (absolute positioned, 56x56px circle)
- **Behavior:** Opens `NewWorktreeModal` — a single-purpose worktree creation dialog
- **Tooltip:** "Create new worktree" (or "Create a repository first" / "Disconnected from daemon")

### What Exists Today
| Primitive   | Creation UI Exists? | Where?                                           |
|-------------|---------------------|--------------------------------------------------|
| Worktree    | Yes                 | `NewWorktreeModal` (standalone, used by + button) |
| Board       | Yes                 | `BoardsTable` in Settings modal                   |
| Repository  | Yes                 | `ReposTable` in Settings modal                     |
| Assistant   | Yes                 | `AssistantsTable` in Settings modal                |

All four creation flows exist but are scattered. The + button only surfaces worktrees. Boards, repos, and assistants are buried in Settings.

---

## Proposed Design

### Component: `CreateDialog`

A **modal** (not drawer) with **vertical tabs** on the left side. Each tab represents a first-class Agor primitive.

**Why modal over drawer?**
- Creation is a focused, intentional action — not a side panel
- Modal centers attention and creates a clear "decision moment"
- Consistent with existing patterns in the codebase

**Why vertical tabs on the left?**
- Allows room for icon + label + subtle description
- Feels more like a "launcher" than horizontal tabs
- Scales better as more primitives are added

### Tab Design

```
┌─────────────────────────────────────────────────────────────────────┐
│  Create New...                                                   ✕ │
├──────────────┬──────────────────────────────────────────────────────┤
│              │                                                      │
│  🔧 Worktree │  Perfect for coding tasks. Requires a code          │
│              │  repository. Generally ephemeral — has the lifecycle │
│  🤖 Assistant│  of a feature's development.                        │
│              │                                                      │
│  📋 Board    │  ┌──────────────────────────────────────────┐       │
│              │  │ Repository    [apache/superset     ▼]    │       │
│  📦 Repository│ │ Source Branch [main                ▼]    │       │
│              │  │ Worktree Name [fix-login-bug        ]    │       │
│              │  │ Issue URL     [                     ]    │       │
│              │  │ PR URL        [                     ]    │       │
│              │  └──────────────────────────────────────────┘       │
│              │                                                      │
│              │                          ┌──────────────────┐       │
│              │                          │ Create Worktree  │       │
│              │                          └──────────────────┘       │
├──────────────┴──────────────────────────────────────────────────────┤
└─────────────────────────────────────────────────────────────────────┘
```

### Tab Naming Decision

**Recommendation: Use the primitive name with descriptive purpose text.**

| Tab     | Label        | Icon              | Rationale |
|---------|--------------|-------------------|-----------|
| Tab 1   | Worktree     | `BranchesOutlined`| Correct term. Description explains it's for coding. Users who learn the term build better mental models. |
| Tab 2   | Assistant    | `RobotOutlined`   | Already established in the codebase. Clear and evocative. |
| Tab 3   | Board        | `AppstoreOutlined` | Established term in the product. |
| Tab 4   | Repository   | `FolderOutlined`  | Standard git terminology. |

**Why not "Coding Task"?** Worktrees aren't tasks — they're environments. A worktree can host many tasks/sessions. Calling it "Coding Task" would be misleading. The purpose description does the explaining.

### Tab Content Layout

Each tab follows the same structure:
1. **Purpose text** — A single paragraph in `Typography.Text type="secondary"`, small font
2. **Form** — The creation form (reusing existing form components where possible)
3. **Primary action button** — Bottom-right of the modal footer

### Modal Configuration
- **Width:** 720px (same as existing `NewWorktreeModal` at 700px, slightly wider for tabs)
- **Title:** "Create New..."
- **Footer:** Dynamic — shows the correct action button per tab

---

## Component Architecture

### New Components
```
apps/agor-ui/src/components/CreateDialog/
├── CreateDialog.tsx           # Main modal with Tabs
├── CreateDialog.types.ts      # Shared types/interfaces
├── tabs/
│   ├── WorktreeTab.tsx        # Wraps existing WorktreeFormFields
│   ├── AssistantTab.tsx       # Extracted from AssistantsTable create modal
│   ├── BoardTab.tsx           # Extracted from BoardsTable create modal
│   └── RepoTab.tsx            # Extracted from ReposTable create modal
└── index.ts                   # Barrel export
```

### Reuse Strategy
| Component             | Action                                            |
|-----------------------|---------------------------------------------------|
| `WorktreeFormFields`  | Reuse directly — it's already a standalone form    |
| Board creation form   | Extract from `BoardsTable` into `BoardTab`         |
| Repo creation form    | Extract from `ReposTable` into `RepoTab`           |
| Assistant creation    | Extract from `AssistantsTable` into `AssistantTab`  |

### Integration Points
- `NewSessionButton` → opens `CreateDialog` instead of `NewWorktreeModal`
- `App.tsx` → replace `newWorktreeModalOpen` state with `createDialogOpen`
- Pass all existing callbacks (onCreate handlers for each type) to `CreateDialog`

---

## Implementation Phases

### Phase 1: Create the Dialog Shell
- Build `CreateDialog` with Ant Design `Tabs` (tabPosition="left") inside a `Modal`
- Wire up tab switching, dynamic footer buttons
- Purpose text for each tab

### Phase 2: Worktree Tab
- Move existing `NewWorktreeModal` form logic into `WorktreeTab`
- Reuse `WorktreeFormFields` component directly
- Keep all existing validation and localStorage behavior

### Phase 3: Board Tab
- Extract board creation form from `BoardsTable`
- Simplified version: name + icon + description + background
- Omit custom context JSON for the creation flow (keep it for edit)

### Phase 4: Repository Tab
- Extract repo creation form from `ReposTable`
- Remote/Local radio toggle, URL/path input, slug, default branch

### Phase 5: Assistant Tab
- Extract assistant creation from `AssistantsTable`
- Display name, emoji, board selector, advanced options (collapsed)

### Phase 6: Wire Up
- Update `NewSessionButton` tooltip to "Create new..."
- Update `App.tsx` to use `CreateDialog` instead of `NewWorktreeModal`
- Pass all required callbacks and data maps

---

## Visual Design Notes

- **Active tab indicator:** Left border accent (Ant Design default for vertical tabs)
- **Purpose text:** `fontSize: 13`, `color: token.colorTextSecondary`, `marginBottom: 16`
- **Tab icons:** Inline with label text, using Ant Design icon components
- **Tab labels:** 14px, medium weight when active
- **Empty/disabled states:** Assistant tab shows normally (backend exists), all tabs functional
- **Modal appears centered** with subtle entrance animation (Ant Design default)
