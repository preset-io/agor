# Design Principles

Related: [[core]], [[architecture]]

This document outlines Agor UI's design principles, component patterns, and technical standards.

## Tech Stack

### Core Framework

- **Vite + React + TypeScript** - Fast, modern, lightweight
- **Ant Design** - Primary component library
- **X Ant Design** - Chat/session-specific components
  - React Flow for visual session tree canvas
  - Future: Bubble/Conversations for chat interfaces

### Development Tools

- **Storybook** - Component development and documentation
- **Vitest + RTL** - Testing framework
- **TypeScript** - Type safety for domain models

### Rationale

- **Vite over Next.js** - Faster iteration, no routing/SSR overhead
- **Storybook-first** - Isolated component development
- **Type-driven** - All components receive typed props (Session, Task, Board, etc.)

## UI Standards

### Theming

- **Dark mode by default** - ConfigProvider with `theme.darkAlgorithm`
- **Strict Ant Design token usage** - No custom CSS, only Ant Design theme tokens
  - `token.colorBgContainer` for backgrounds
  - `token.colorBorder` for borders
  - `token.borderRadiusLG` for rounded corners
  - See Ant Design theme documentation for full token list

### Icon Consistency

- **Use Ant Design icons only** - No emojis in UI components (unless user explicitly requests)
- Standard icons:
  - `MessageOutlined` - Message count
  - `ToolOutlined` - Tool usage
  - `FileTextOutlined` - Reports
  - `GithubOutlined` - Git state
  - `EditOutlined` - Dirty state
  - `LoadingOutlined` with `Spin` - Running/in-progress states

### Color Patterns

- **Status colors** (from Ant Design theme):
  - Running: `processing` (blue)
  - Completed: `success` (green)
  - Failed: `error` (red)
  - Idle: `default` (gray)
- **Git dirty state**: Orange tag with EditOutlined icon
- **Board colors**: Custom hex colors for visual distinction

## Component Architecture

### Atomic Design Pattern

- **Atoms**: Button, Input, Tag, Badge (from Ant Design)
- **Molecules**: TaskListItem, AgentSelectionCard, NewSessionButton
- **Organisms**: SessionCard, SessionDrawer, SessionListDrawer, SessionCanvas
- **Templates**: App layout with header + content + drawers
- **Pages**: App component (full orchestration)

### Component Standards

- **Props interface**: Export TypeScript interface for all props
- **Storybook stories**: Minimum 3-5 stories per component
- **Read before edit**: Always read file before editing (enforced by tools)
- **No custom CSS files**: Use Ant Design components and inline styles with tokens
- **Prefer Edit over Write**: Always edit existing files rather than creating new ones

### File Structure

```
ComponentName/
├── ComponentName.tsx          # Component implementation
├── ComponentName.stories.tsx  # Storybook stories
├── ComponentName.css          # CSS (avoid if possible)
└── index.ts                   # Export
```

## Key UI Patterns

### Two-Drawer Overlay System

- **Left drawer**: Session list browser
  - Triggered by AppHeader menu button or board name click
  - Board switcher at top (Select dropdown)
  - Search bar for filtering sessions
  - Session list filtered by current board
  - Click session → opens right drawer + closes left drawer

- **Right drawer**: Session detail
  - Triggered by clicking session cards
  - Full conversation with task timeline
  - Dynamic input box at bottom with action buttons (Send, Fork, Subsession)
  - Sticky footer positioning

### Session Card Click Behavior

- **Header section**: Clickable (triggers drawer)
- **Metadata section** (description, git state, concepts): Clickable (triggers drawer)
- **Tasks section**: NOT clickable (prevents conflicts with collapse/task clicks)
- **Expand button**: Explicit trigger with stopPropagation
- **Cursor affordance**: Pointer cursor on clickable areas

### Board System

- **Board**: Collection of sessions (like Trello boards)
- **Board switcher**: Dropdown in left drawer
- **Current board indicator**: Icon + name in AppHeader (clickable to open drawer)
- **Canvas filtering**: Show only sessions from current board

### Session Canvas

- **React Flow** for infinite canvas with zoom/pan
- **Snap to grid**: 20x20 pixel grid for clean alignment
- **Session cards as nodes**: Full SessionCard components as draggable nodes
- **Fork edges**: Dashed line with cyan color
- **Spawn edges**: Solid line with purple color, animated
- **MiniMap**: Color-coded by session status

### Settings Modal Patterns

#### API Key Fields

- **Individual field per key** - Anthropic, OpenAI, Gemini
- **Status indicators** - "Set" (green check) or "Not Set" (gray X)
- **Masked inputs** - Use `Input.Password` for security
- **Save/Clear actions** - Separate buttons for each key
- **Never expose values** - Only show boolean status once saved

#### Environment Variables Editor (Accumulator Pattern)

- **Table view** - Shows all configured env vars with status
- **Key-value pairs** - Variable name (code font) + encrypted status
- **Inline editing** - Click "Update" to modify existing value (password-masked)
- **Add form at bottom** - Two-input compact group (name + value) with Add button
- **Delete per variable** - Danger button with trash icon
- **No text area** - Each variable is an independent row (better UX than `.env` file)
- **Status visibility** - "Set (encrypted)" tag when variable has a value
- **Validation feedback** - Show errors for invalid var names (e.g., blocklisted vars)

**Rationale for Accumulator Pattern:**

- ✅ Clear per-variable status (which vars are encrypted vs empty)
- ✅ Granular operations (update one var without re-entering all)
- ✅ Individual encryption (each var encrypted separately in database)
- ✅ Security (only one value visible at time when editing)
- ✅ Consistency with MCP Servers Table, Users Table patterns
- ❌ Text area approach (`.env` file style) has poor UX: no validation, no status indicators, all values visible at once

**UI Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│ Variable Name      │ Value               │ Actions          │
├────────────────────┼─────────────────────┼──────────────────┤
│ GITHUB_TOKEN       │ ● Set (encrypted)   │ [Update][Delete] │
│ NPM_TOKEN          │ ● Set (encrypted)   │ [Update][Delete] │
│ AWS_ACCESS_KEY_ID  │ ● Set (encrypted)   │ [Update][Delete] │
└────────────────────┴─────────────────────┴──────────────────┘

Add New Variable:
[Name______________] [●●●●●●●●●●] [+ Add]
```

## Visual Design Patterns

### Status Indicators

- **Running**: Animated `Spin` with `LoadingOutlined` icon (no static badge)
- **Completed/Failed/Idle**: Badge with status color

### Git State Display

- **Current SHA only**: Show just end SHA (e.g., `abc3214`), not transitions
- **Dirty indicator**: Orange tag with EditOutlined icon
- **Format**: `{sha}-dirty` suffix in data, stripped for display

### Task Display

- **Visible tasks**: Show last 5 tasks chronologically (oldest → newest)
- **"See more" button**: At top of task list if >5 tasks
- **Truncation**: 120 chars for task descriptions (`TRUNCATION_LENGTH`)
- **Tooltip**: Full prompt on status icon hover (not on text)

### Session Card Layout

- **Max width**: `SESSION_CARD_MAX_WIDTH = 480` pixels
- **Collapsible tasks**: Only task list collapses (header/metadata always visible)
- **Genealogy tags**: Fork (cyan) and Spawn (purple) badges in header

## Mock Data Strategy

### Realistic Data

- **18+ realistic user prompts** - Multi-line, conversational
- **Tool counts** - All tasks/sessions include `tool_use_count`
- **Git dirty state** - Some tasks/sessions use `{sha}-dirty` to show uncommitted changes
- **4 mock agents** - claude-code, codex (installed), cursor, gemini (not installed)
- **3 mock boards** - Default Board, Experiments, Bug Fixes

### Naming Conventions

- Sessions: `mockSessionA`, `mockSessionB`, `mockSessionC`
- Tasks: `mockTask001`, `mockTask002`, etc.
- Boards: `mockBoardDefault`, `mockBoardExperiments`, `mockBoardBugFixes`
- Agents: `mockAgentClaudecode`, `mockAgentCodex`, etc.

## Storybook Best Practices

### Story Coverage

- Default state
- Running/completed/failed states
- Empty states
- Edge cases (many tasks, long prompts, etc.)
- Interactive states (hover, click)

### Dark Mode

All stories use dark theme decorator:

```typescript
decorators: [
  (Story) => (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <Story />
    </ConfigProvider>
  ),
],
```

## Code Quality Standards

### TypeScript

- **Strict mode enabled** - No `any` types
- **Export interfaces** - All prop interfaces exported
- **Type imports** - Use `import type` for types

### React Patterns

- **Functional components** - No class components
- **Hooks** - `useState`, `useToken`, `useNodesState`, etc.
- **Props destructuring** - Destructure props in function signature
- **Optional chaining** - Use `?.` for optional props

### Performance

- **Memoization** - Use `useMemo` for expensive computations
- **React Flow optimization** - `onlyRenderVisibleElements` for large graphs
- **Lazy loading** - Code split large components when needed

---

See also:

- [[core]] - Core concepts and primitives
- [[architecture]] - System architecture
