# Board Markdown Notes

**Status:** ✅ Implemented
**Type:** Board object (`'markdown'`)
**Component:** `SessionCanvas/canvas/MarkdownNode.tsx`
**Related:** [board-objects.md](./board-objects.md), [design.md](./design.md)

---

## Overview

Markdown notes are free-floating text annotations on boards with full markdown rendering capabilities. They function like sticky notes but support rich formatting (headers, lists, code blocks, links, etc.).

### Use Cases

- **Sprint goals** - Document objectives directly on board
- **Architecture diagrams** - Annotate zones with technical context
- **Release checklists** - Track TODO lists visually
- **Meeting notes** - Capture decisions near relevant worktrees
- **ADRs** - Architecture Decision Records linked to zones

---

## Data Model

### Type Extension

```typescript
// packages/core/src/types/board.ts

export type BoardObjectType = 'text' | 'zone' | 'markdown'; // Add 'markdown'

export interface MarkdownBoardObject {
  type: 'markdown';
  x: number;
  y: number;
  width: number; // User-selected width (300-800px)
  content: string; // Markdown text
  fontSize?: number; // Font size multiplier (future)
  backgroundColor?: string; // Background color (future)
}

export type BoardObject = TextBoardObject | ZoneBoardObject | MarkdownBoardObject;
```

**Note:** Markdown notes are stored via the `board-objects` service, which persists to the `board_objects` table in the database.

---

## User Flow

### Creating a Note

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
```

### Editing a Note

```
1. User clicks edit button on note card
2. Textarea appears inline with current content
3. User edits markdown
4. User clicks "Save" or "Cancel"
5. Note updates (or reverts if cancelled)
```

### Deleting a Note

```
1. User activates eraser tool
2. User clicks on markdown note
3. Note is deleted from board
```

---

## Implementation

### 1. Tool Button

**File:** `SessionCanvas.tsx:1691`

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

**Import:**

```tsx
import { FileMarkdownOutlined } from '@ant-design/icons';
```

### 2. State Management

**Update activeTool type:**

```typescript
const [activeTool, setActiveTool] = useState<'select' | 'zone' | 'comment' | 'eraser' | 'markdown'>(
  'select'
);
```

**Add markdown modal state:**

```typescript
const [markdownModal, setMarkdownModal] = useState<{
  position: { x: number; y: number }; // React Flow coordinates
} | null>(null);

const [markdownContent, setMarkdownContent] = useState('');
const [markdownWidth, setMarkdownWidth] = useState(500);
```

### 3. Click Handler

**Add to `handlePaneClick`:**

```typescript
if (activeTool === 'markdown' && reactFlowInstanceRef.current) {
  const position = reactFlowInstanceRef.current.screenToFlowPosition({
    x: event.clientX,
    y: event.clientY,
  });

  setMarkdownModal({ position });
}
```

### 4. Creation Modal

```tsx
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
              500: '500px',
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
            placeholder="# Title\n\n- Bullet point\n- Another point\n\n**Bold** and *italic*"
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

**Imports:**

```tsx
import ReactMarkdown from 'react-markdown';
import { Slider } from 'antd';
```

### 5. Create Handler

```typescript
const handleCreateMarkdownNote = useCallback(async () => {
  if (!markdownModal || !board || !client || !markdownContent.trim()) return;

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
          client
            .service('boards')
            .patch(board.board_id, {
              _action: 'upsertObject',
              objectId: id,
              objectData: data,
            })
            .catch(console.error);
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
    });
  } catch (error) {
    console.error('Failed to add markdown note:', error);
    setNodes(nodes => nodes.filter(n => n.id !== objectId));
  }

  // Reset state
  setMarkdownModal(null);
  setMarkdownContent('');
  setMarkdownWidth(500);
  setActiveTool('select');
}, [markdownModal, board, client, markdownContent, markdownWidth]);
```

---

## MarkdownNode Component

### Component Implementation

**File:** `SessionCanvas/canvas/MarkdownNode.tsx`

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

export const MarkdownNode: React.FC<{ data: MarkdownNodeData }> = ({ data }) => {
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
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
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

### Register Node Type

**File:** `SessionCanvas.tsx:208`

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

### File: `useBoardObjects.ts`

Add markdown node handling in `getBoardObjectNodes`:

```typescript
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
            })
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
- Can be used for release notes, sprint goals, architecture diagrams

---

## Height Behavior

**Dynamic height** - No manual height control needed.

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

**Package:** `react-markdown` ~9.0.0 (CommonMark compliant, small bundle)

---

## Design Rationale

### Why Modal Instead of Inline?

**Pros of modal approach:**

- More space for longer content
- Live preview alongside editing
- Width adjustment before creation
- Clear creation flow (create → edit later)
- Doesn't clutter canvas with UI controls

**Decision:** Modal for creation, inline for editing (shorter edits)

### Why Fixed Width + Auto Height?

**Alternatives considered:**

1. Manual resize (like zones) - Too fiddly for text
2. Auto width - Text becomes one long line
3. Manual width + manual height - Overkill, height should match content
4. Auto everything - Width unpredictable

**Decision:** User picks width once (sensible default), height auto-expands.

### Why Markdown Instead of Rich Text?

**Markdown advantages:**

- Keyboard-friendly (no mouse for formatting)
- Portable (plain text)
- Version control friendly
- Fast to type
- Engineers prefer it

**Decision:** Markdown for now, could add rich text toolbar later.

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

Add formatting toolbar:

- Bold, italic, strikethrough buttons
- Heading level selector (H1-H6)
- List buttons (bullet, numbered)
- Link insertion modal
- Code block insertion

**Implementation:** Use `react-md-editor` or `react-simplemde-editor`

### Phase 3: Styling Options

Add customization:

- Background color picker (like zones)
- Font size multiplier (0.8x - 1.5x)
- Border color/style
- Shadow intensity

**UI:** Settings icon in card header → popover with color pickers

### Phase 4: Pin to Parents

Like comments, allow markdown notes to pin to zones/worktrees:

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

Common markdown templates:

- Meeting notes
- TODO list
- Release checklist
- Architecture Decision Record (ADR)
- Sprint goals

**UI:** Dropdown in modal: "Start from template..."

### Phase 6: Export

Export markdown notes to files:

- CLI: `agor board export --board main --format md`
- UI: Right-click note → "Export as .md"
- Batch export all notes on board

---

## Related Documentation

- **[board-objects.md](./board-objects.md)** - Board object types and architecture
- **[design.md](./design.md)** - UI/UX principles
- **[frontend-guidelines.md](./frontend-guidelines.md)** - React patterns and Ant Design

---

## Summary

Markdown notes extend board objects with rich text annotation capabilities. By using a modal-based creation flow with width selection and live preview, users can create well-formatted notes that automatically expand to fit content. The implementation leverages React Flow's node system and React Markdown's rendering to provide a seamless annotation experience.

**Key decisions:**

- Modal creation for better UX
- User-selected width with auto height
- Inline editing for quick updates
- z-index 600 (above worktrees, below comments)
- Markdown rendering via react-markdown

**Implementation priority:** Quick wins (2-3 hours) for high-value feature that enhances board organization and documentation.
