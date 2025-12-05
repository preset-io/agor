# Markdown Notes on Boards

**Status:** 📝 Exploration (Ready to Implement)
**Related:** [board-objects.md](../concepts/board-objects.md), [design.md](../concepts/design.md)

---

## Overview

Add markdown notes to boards as a new board object type. Markdown notes are free-floating text annotations that support rich formatting, similar to sticky notes but with full markdown capabilities.

### What This Adds

**New board object type:** `'markdown'` alongside existing `'text'` and `'zone'`

**Key features:**

- Click-to-place with modal input
- User-selected fixed width (300-800px)
- Auto-expanding height based on content
- Full markdown rendering (headers, lists, bold, italic, links, code blocks, etc.)
- Draggable and editable
- Layers above worktrees but below comments

---

## User Flow

```
1. User clicks markdown tool button in toolbox (FileMarkdownOutlined icon)
2. User clicks destination on canvas
3. Modal opens with:
   - Width selector (slider: 300px - 800px, default 500px)
   - Markdown textarea (monospace font, auto-expanding)
   - Live preview pane
4. User enters markdown text and adjusts width
5. User clicks "Create"
6. Markdown note appears on canvas at click position
7. User can drag to reposition
8. User can click edit button to modify content
```

**Why this approach?**

- **Modal is better than inline editing** - Gives space for longer content, preview, and width adjustment
- **User-picked width** - Prevents notes from being too narrow (unreadable) or too wide (cluttering canvas)
- **Auto height** - Simpler than manual resize, content always fits perfectly
- **Click-to-place** - Consistent with comment placement (vs drag-to-draw for zones)

---

## Architecture

### Type System

**File:** `packages/core/src/types/board.ts`

**Changes:**

```typescript
// Line 6: Add 'markdown' to BoardObjectType
export type BoardObjectType = 'text' | 'zone' | 'markdown';

// Add new interface
export interface MarkdownBoardObject {
  type: 'markdown';
  x: number;
  y: number;
  width: number; // User-selected width (300-800px)
  content: string; // Markdown text
  // Optional future enhancements:
  fontSize?: number; // Font size multiplier (default: 1.0)
  backgroundColor?: string; // Background color with alpha (default: card background)
}

// Line 94: Update BoardObject union
export type BoardObject = TextBoardObject | ZoneBoardObject | MarkdownBoardObject;
```

**No schema migration needed** - `board.objects` is already a JSON blob.

---

## UI Implementation

### 1. Tool Button

**File:** `apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx:1691`

**Add after "Add Comment" button:**

```tsx
<ControlButton
  onClick={e => {
    e.stopPropagation();
    setActiveTool('markdown');
  }}
  title="Add Markdown Note"
  style={{
    borderLeft: activeTool === 'markdown' ? '3px solid #1677ff' : 'none',
  }}
>
  <FileMarkdownOutlined style={{ fontSize: '16px' }} />
</ControlButton>
```

**Import icon:**

```tsx
import { FileMarkdownOutlined } from '@ant-design/icons';
```

---

### 2. State Management

**File:** `apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx:253`

**Update activeTool type:**

```typescript
const [activeTool, setActiveTool] = useState<'select' | 'zone' | 'comment' | 'eraser' | 'markdown'>(
  'select'
);
```

**Add markdown modal state:**

```typescript
// Markdown placement state (click-to-place)
const [markdownModal, setMarkdownModal] = useState<{
  position: { x: number; y: number }; // React Flow coordinates
} | null>(null);

const [markdownContent, setMarkdownContent] = useState('');
const [markdownWidth, setMarkdownWidth] = useState(500); // Default width
```

---

### 3. Click Handler

**File:** `apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx:1464`

**Add to `handlePaneClick`:**

```typescript
const handlePaneClick = useCallback(
  (event: React.MouseEvent) => {
    // ... existing comment logic ...

    // Markdown tool: click-to-place
    if (activeTool === 'markdown' && reactFlowInstanceRef.current) {
      const position = reactFlowInstanceRef.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      setMarkdownModal({ position });
    }
  },
  [activeTool]
);
```

---

### 4. Modal Component

**File:** `apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx` (after triggerModal JSX)

**Add modal JSX:**

```tsx
{
  /* Markdown note creation modal */
}
{
  markdownModal && (
    <Modal
      open={true}
      title="Add Markdown Note"
      onCancel={() => {
        setMarkdownModal(null);
        setMarkdownContent('');
        setMarkdownWidth(500);
        setActiveTool('select');
      }}
      onOk={handleCreateMarkdownNote}
      okText="Create"
      okButtonProps={{ disabled: !markdownContent.trim() }}
      width={800}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Width selector */}
        <div>
          <Typography.Text strong>Width:</Typography.Text>
          <Slider
            min={300}
            max={800}
            step={50}
            value={markdownWidth}
            onChange={setMarkdownWidth}
            marks={{
              300: '300px',
              400: '400px',
              500: '500px',
              600: '600px',
              700: '700px',
              800: '800px',
            }}
            style={{ marginTop: 8 }}
          />
        </div>

        {/* Markdown textarea */}
        <div>
          <Typography.Text strong>Content (Markdown supported):</Typography.Text>
          <Input.TextArea
            value={markdownContent}
            onChange={e => setMarkdownContent(e.target.value)}
            placeholder={`# Title\n\n- Bullet point\n- Another point\n\n**Bold** and *italic*\n\n\`\`\`javascript\nconst code = "example";\n\`\`\``}
            autoFocus
            rows={10}
            style={{ fontFamily: 'monospace', marginTop: 8 }}
          />
        </div>

        {/* Preview */}
        <div>
          <Typography.Text strong>Preview:</Typography.Text>
          <div
            style={{
              marginTop: 8,
              padding: 12,
              border: `1px solid ${token.colorBorder}`,
              borderRadius: 4,
              maxHeight: 300,
              overflow: 'auto',
              background: token.colorBgContainer,
            }}
          >
            {markdownContent.trim() ? (
              <ReactMarkdown>{markdownContent}</ReactMarkdown>
            ) : (
              <Typography.Text type="secondary">Preview will appear here...</Typography.Text>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
```

**Imports needed:**

```tsx
import ReactMarkdown from 'react-markdown';
import { Slider } from 'antd';
```

---

### 5. Create Handler

**File:** `apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx`

**Add handler function:**

```typescript
const handleCreateMarkdownNote = useCallback(async () => {
  if (!markdownModal || !board || !client || !markdownContent.trim()) {
    return;
  }

  const objectId = `markdown-${Date.now()}`;
  const position = markdownModal.position;

  // Optimistic update
  setNodes(nodes => [
    ...nodes,
    {
      id: objectId,
      type: 'markdown',
      position,
      draggable: true,
      zIndex: 600, // Above worktrees (500), below comments (1000)
      data: {
        objectId,
        content: markdownContent,
        width: markdownWidth,
        onUpdate: (id: string, data: BoardObject) => {
          if (board && client) {
            client
              .service('boards')
              .patch(board.board_id, {
                _action: 'upsertObject',
                objectId: id,
                objectData: data,
              } as any)
              .catch(console.error);
          }
        },
      },
    },
  ]);

  // Persist to backend
  try {
    await client.service('boards').patch(board.board_id, {
      _action: 'upsertObject',
      objectId,
      objectData: {
        type: 'markdown',
        x: position.x,
        y: position.y,
        width: markdownWidth,
        content: markdownContent,
      },
    } as any);

    console.log(`✓ Created markdown note ${objectId}`);
  } catch (error) {
    console.error('Failed to add markdown note:', error);
    // Rollback optimistic update
    setNodes(nodes => nodes.filter(n => n.id !== objectId));
  }

  // Reset state
  setMarkdownModal(null);
  setMarkdownContent('');
  setMarkdownWidth(500);
  setActiveTool('select');
}, [markdownModal, board, client, markdownContent, markdownWidth, setNodes]);
```

---

## Markdown Node Component

### File Structure

**Create new file:** `apps/agor-ui/src/components/SessionCanvas/canvas/MarkdownNode.tsx`

**Component implementation:**

```tsx
import { EditOutlined } from '@ant-design/icons';
import { Button, Card, Input, Typography, theme } from 'antd';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { BoardObject } from '@agor/core/types';

interface MarkdownNodeData {
  objectId: string;
  content: string;
  width: number;
  onUpdate: (id: string, data: BoardObject) => void;
}

export const MarkdownNode = ({ data }: { data: MarkdownNodeData }) => {
  const { token } = theme.useToken();
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(data.content);

  const handleSave = () => {
    data.onUpdate(data.objectId, {
      type: 'markdown',
      x: 0, // Position managed by React Flow
      y: 0,
      width: data.width,
      content: editContent,
    });
    setEditing(false);
  };

  const handleCancel = () => {
    setEditContent(data.content);
    setEditing(false);
  };

  return (
    <Card
      style={{
        width: data.width,
        minHeight: 100,
        background: token.colorBgContainer,
        border: `2px solid ${token.colorBorder}`,
        borderRadius: 8,
        boxShadow: token.boxShadowSecondary,
        cursor: 'move',
      }}
      size="small"
      title={
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Markdown Note
          </Typography.Text>
          {!editing && (
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={e => {
                e.stopPropagation();
                setEditing(true);
              }}
              title="Edit note"
            />
          )}
        </div>
      }
      bodyStyle={{ padding: 12 }}
    >
      {editing ? (
        <div>
          <Input.TextArea
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            rows={8}
            style={{
              fontFamily: 'monospace',
              marginBottom: 8,
              fontSize: token.fontSizeSM,
            }}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="small" onClick={handleCancel}>
              Cancel
            </Button>
            <Button size="small" type="primary" onClick={handleSave} disabled={!editContent.trim()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div
          className="markdown-content"
          style={{
            fontSize: token.fontSize,
            color: token.colorText,
            lineHeight: 1.6,
          }}
        >
          <ReactMarkdown>{data.content}</ReactMarkdown>
        </div>
      )}
    </Card>
  );
};
```

**Register in SessionCanvas.tsx:208:**

```typescript
import { MarkdownNode } from './canvas/MarkdownNode';

const nodeTypes = {
  sessionNode: SessionNode,
  worktreeNode: WorktreeNode,
  zone: ZoneNode,
  cursor: CursorNode,
  comment: CommentNode,
  markdown: MarkdownNode, // Add this
};
```

---

## Board Objects Hook Integration

### File: `apps/agor-ui/src/components/SessionCanvas/canvas/useBoardObjects.ts`

**Add markdown node handling in `getBoardObjectNodes` function:**

```typescript
// After zone handling, add:
if (objectData.type === 'markdown') {
  return {
    id: objectId,
    type: 'markdown',
    position: { x: objectData.x, y: objectData.y },
    draggable: true,
    selectable: true,
    zIndex: 600, // Above worktrees (500), below comments (1000)
    data: {
      objectId,
      content: objectData.content,
      width: objectData.width,
      onUpdate: (id: string, data: BoardObject) => {
        if (board && client) {
          client
            .service('boards')
            .patch(board.board_id, {
              _action: 'upsertObject',
              objectId: id,
              objectData: data,
            } as any)
            .catch(console.error);
        }
      },
    },
  };
}
```

---

## Layering (z-index)

```
1000 - Comments (top, highest priority)
 600 - Markdown notes (annotations layer)
 500 - Worktrees (primary content)
 100 - Zones (organizational layer, bottom)
```

**Rationale:**

- Markdown notes above worktrees so they're readable as annotations
- Below comments to maintain comment hierarchy for discussions
- Can be used for release notes, sprint goals, architecture diagrams, etc.

---

## Height Behavior

**Dynamic height** - No manual height control needed!

1. User enters markdown content in modal
2. React renders `<Card>` with `<ReactMarkdown>` inside
3. Content naturally expands based on text length
4. React Flow measures actual DOM height automatically
5. Height updates when content is edited

**Why this works:**

- No `height` style set on Card = auto-sizing
- `minHeight: 100` ensures minimum visual presence
- Markdown renderer handles all formatting (lists, code blocks, etc.)
- React Flow collision detection uses measured dimensions

---

## Dependencies

### Install react-markdown

```bash
cd apps/agor-ui
pnpm add react-markdown
pnpm add -D @types/react-markdown
```

**Package info:**

- **react-markdown:** ~9.0.0 (CommonMark compliant, small bundle)
- Works with Ant Design's dark mode
- Supports GitHub-flavored markdown syntax

---

## Effort Estimate

**Total: 2-3 hours**

| Task                                         | Time   |
| -------------------------------------------- | ------ |
| Type updates (board.ts)                      | 15 min |
| Tool button + state management               | 15 min |
| Click handler integration                    | 15 min |
| Modal UI (width slider + textarea + preview) | 45 min |
| Create handler + persistence                 | 30 min |
| MarkdownNode component                       | 60 min |
| useBoardObjects integration                  | 15 min |
| Testing + polish                             | 30 min |

---

## Testing Checklist

**Basic functionality:**

- [ ] Click markdown tool, tool button shows active state
- [ ] Click canvas, modal opens at click position
- [ ] Enter markdown text in textarea
- [ ] Adjust width slider, preview updates
- [ ] Click "Create", note appears on canvas
- [ ] Note renders markdown correctly (headers, lists, bold, italic, code)
- [ ] Note has correct width as selected

**Interactions:**

- [ ] Can drag note to new position
- [ ] Position persists in database
- [ ] Click edit button, textarea appears
- [ ] Edit content, click save, content updates
- [ ] Click cancel, reverts to original content
- [ ] Eraser tool deletes markdown notes

**Multi-user sync:**

- [ ] User A creates note, User B sees it appear
- [ ] User A edits note, User B sees update
- [ ] User A drags note, User B sees movement
- [ ] User A deletes note, User B sees it disappear

**Edge cases:**

- [ ] Empty content - "Create" button disabled
- [ ] Very long content - scrolls or expands gracefully
- [ ] Special markdown (code blocks, tables) - renders correctly
- [ ] Dark mode - all colors readable
- [ ] Page reload - notes persist and render correctly

---

## Future Enhancements

### Phase 2: Rich Editor

**Add formatting toolbar:**

- Bold, italic, strikethrough buttons
- Heading level selector (H1-H6)
- List buttons (bullet, numbered)
- Link insertion modal
- Code block insertion

**Implementation:** Use a markdown WYSIWYG editor like `react-md-editor` or `react-simplemde-editor`

### Phase 3: Styling Options

**Add customization:**

- Background color picker (like zones)
- Font size multiplier (0.8x - 1.5x)
- Border color/style
- Shadow intensity

**UI:** Settings icon in card header → popover with color pickers and sliders

### Phase 4: Pin to Parents

**Like comments, allow markdown notes to pin to zones/worktrees:**

```typescript
interface MarkdownBoardObject {
  // ... existing fields ...
  parentId?: string; // Zone or worktree ID
  parentType?: 'zone' | 'worktree';
  // Position becomes relative to parent when pinned
}
```

**Benefits:**

- Architecture diagrams move with zones
- Session-specific notes follow worktrees
- Keeps annotations organized

### Phase 5: Templates

**Common markdown templates:**

- Meeting notes
- TODO list
- Release checklist
- Architecture decision record (ADR)
- Sprint goals

**UI:** Dropdown in modal: "Start from template..."

### Phase 6: Export

**Export markdown notes to files:**

- CLI: `agor board export --board main --format md`
- UI: Right-click note → "Export as .md"
- Batch export all notes on board

---

## Design Rationale

### Why Modal Instead of Inline?

**Pros of modal approach:**

- More space for longer content
- Live preview alongside editing
- Width adjustment before creation
- Clear creation flow (create → edit later)
- Doesn't clutter canvas with UI controls

**Cons of inline approach:**

- Harder to see preview while typing
- Width adjustment awkward (drag handles?)
- Creating long notes feels cramped
- Unclear when creation is "done"

**Decision:** Modal for creation, inline for editing (shorter edits)

### Why Fixed Width + Auto Height?

**Alternatives considered:**

1. **Manual resize (like zones):** Too fiddly for text content, users prefer predictable width
2. **Auto width:** Text becomes one long line, unreadable
3. **Manual width + manual height:** Overkill, height should match content
4. **Auto everything:** Width becomes unpredictable

**Decision:** User picks width once (sensible default), height auto-expands. Simple and predictable.

### Why Markdown Instead of Rich Text?

**Markdown advantages:**

- Keyboard-friendly (no mouse for formatting)
- Portable (plain text)
- Version control friendly
- Fast to type
- Engineers prefer it

**Rich text advantages:**

- Easier for non-technical users
- WYSIWYG editing

**Decision:** Markdown for now, could add rich text toolbar later (still stores as markdown)

---

## References

- **React Markdown:** https://github.com/remarkjs/react-markdown
- **CommonMark Spec:** https://commonmark.org/
- **Ant Design Card:** https://ant.design/components/card
- **Board Objects:** [context/concepts/board-objects.md](../concepts/board-objects.md)
- **React Flow Custom Nodes:** https://reactflow.dev/examples/nodes/custom-node

---

## Implementation Order

1. **Backend (types only):** Add `MarkdownBoardObject` type - no migrations needed
2. **Frontend UI:** Tool button, modal, click handler
3. **Node component:** MarkdownNode with rendering
4. **Integration:** useBoardObjects, nodeTypes registration
5. **Polish:** Styling, editing, eraser support
6. **Testing:** Multi-user sync, persistence

**Can be done in a single PR** - minimal surface area, no breaking changes.
