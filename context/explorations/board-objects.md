# Board Objects (Canvas Annotations)

**Status:** Exploration / Planning
**Related:** [../concepts/models.md](../concepts/models.md), [../concepts/architecture.md](../concepts/architecture.md)

---

## Overview

Board Objects are visual annotations for React Flow canvases that complement sessions with supporting context. Think of them as "sticky notes" or "zone markers" on a whiteboard.

**Use Cases:**

- **Text Labels** - Document decisions, add notes, create headings
- **Zone Rectangles** - Organize sessions into visual regions (Kanban columns, status zones, feature areas)
- **Future:** Arrows, shapes, images, embedded files

**Key Insight:** Board Objects are lightweight visual primitives stored in the board's JSON data layer with atomic per-object updates to prevent concurrent write conflicts.

---

## Storage Strategy: Atomic JSON Upserts (Recommended ⭐)

Store board objects in the existing `boards.data` field alongside `layout` (session positions), but use **atomic backend methods** to safely update individual objects.

### Schema Extension

```typescript
// packages/core/src/types/board.ts

export type BoardObjectType = 'session' | 'text' | 'zone';

export type BoardLayoutObject =
  | { type: 'session'; x: number; y: number }
  | {
      type: 'text';
      x: number;
      y: number;
      width?: number; // Default: auto-size based on content
      height?: number; // Default: auto-size based on content
      content: string;
      fontSize?: number; // Default: 16
      color?: string; // Text color (default: theme text color)
      background?: string; // Background color (default: transparent)
    }
  | {
      type: 'zone';
      x: number;
      y: number;
      width: number;
      height: number;
      label: string;
      color?: string; // Border/background color (default: #f0f0f0)
      status?: string; // Optional: 'idle' | 'running' | 'completed' | 'failed' (for Kanban)
    };

export interface Board {
  // ... existing fields ...

  /**
   * Canvas objects - sessions AND annotations
   *
   * Keys are object IDs:
   * - Session IDs for sessions (e.g., "0199b856-...")
   * - Generated IDs for annotations (e.g., "text-123", "zone-456")
   *
   * Use `type` discriminator to determine object type.
   *
   * IMPORTANT: Do NOT directly replace this entire object from client.
   * Use atomic backend methods: addBoardObject(), updateBoardObject(), removeBoardObject()
   */
  objects?: {
    [objectId: string]: BoardLayoutObject;
  };

  /**
   * @deprecated Use `objects` instead. Kept for backward compatibility.
   * Will be migrated to `objects` in Phase 1.
   */
  layout?: {
    [sessionId: string]: { x: number; y: number };
  };
}
```

### Database Schema (No Changes Required)

```typescript
// packages/core/src/db/schema.ts - boards table already supports this!

data: text('data', { mode: 'json' }).$type<{
  description?: string;
  sessions: string[];
  color?: string;
  icon?: string;
  layout?: Record<string, { x: number; y: number }>; // ← Existing
  objects?: Record<string, BoardLayoutObject>; // ← New field in JSON
}>();
```

**Why this works:**

- JSON blob already exists, just add new `objects` field
- No schema migration needed
- Backward compatible (keep `layout` during transition)

---

## Atomic Backend Methods (Concurrency-Safe)

### Problem: Concurrent Write Conflicts

**Naive approach (UNSAFE):**

```typescript
// ❌ Client reads, merges, writes - RACE CONDITION!
const board = await get(boardId);
board.objects['text-123'] = newObject;
await patch(boardId, { objects: board.objects }); // Clobbers concurrent writes!
```

**Solution: Atomic per-key updates via SQLite `json_set()`**

SQLite's write lock ensures only one `UPDATE` executes at a time, making per-key updates safe:

```sql
-- Atomic single-key upsert
UPDATE boards
SET
  data = json_set(data, '$.objects.text-123', json('{"type":"text","x":100,"y":200}')),
  updated_at = CURRENT_TIMESTAMP
WHERE board_id = ?
```

**Concurrency behavior:**

- User A updates `objects.session-1` (acquires write lock)
- User B updates `objects.text-456` (waits for lock, then executes with fresh data)
- ✅ No lost updates - each write atomically reads-modifies-writes its key

**Same-key collision:** Last-write-wins (acceptable for position updates)

---

## Backend Implementation

### BoardRepository Methods

```typescript
// packages/core/src/db/repositories/boards.ts

export class BoardRepository {
  /**
   * Atomically add or update a board object
   *
   * Uses SQLite json_set() for safe concurrent updates.
   * Each object ID is updated independently to prevent conflicts.
   */
  async upsertBoardObject(
    boardId: string,
    objectId: string,
    objectData: BoardLayoutObject
  ): Promise<Board> {
    const fullId = await this.resolveId(boardId);

    // Atomic UPDATE with json_set
    await this.db.run(sql`
      UPDATE boards
      SET
        data = json_set(
          COALESCE(data, '{}'),
          '$.objects.${sql.raw(objectId)}',
          ${JSON.stringify(objectData)}
        ),
        updated_at = ${new Date()}
      WHERE board_id = ${fullId}
    `);

    const updated = await this.findById(fullId);
    if (!updated) {
      throw new RepositoryError('Failed to retrieve updated board');
    }

    return updated;
  }

  /**
   * Atomically remove a board object
   */
  async removeBoardObject(boardId: string, objectId: string): Promise<Board> {
    const fullId = await this.resolveId(boardId);

    // Atomic UPDATE with json_remove
    await this.db.run(sql`
      UPDATE boards
      SET
        data = json_remove(data, '$.objects.${sql.raw(objectId)}'),
        updated_at = ${new Date()}
      WHERE board_id = ${fullId}
    `);

    const updated = await this.findById(fullId);
    if (!updated) {
      throw new RepositoryError('Failed to retrieve updated board');
    }

    return updated;
  }

  /**
   * Batch upsert multiple objects (sequential atomic updates)
   *
   * Note: Not a single transaction - each object is updated atomically.
   * This is safe for independent objects but may have partial failures.
   */
  async batchUpsertBoardObjects(
    boardId: string,
    objects: Record<string, BoardLayoutObject>
  ): Promise<Board> {
    for (const [objectId, objectData] of Object.entries(objects)) {
      await this.upsertBoardObject(boardId, objectId, objectData);
    }

    return this.findById(boardId);
  }
}
```

### BoardsService Methods

```typescript
// apps/agor-daemon/src/services/boards.ts

export class BoardsService extends DrizzleService<Board, Partial<Board>, BoardParams> {
  /**
   * Add or update a board object atomically
   */
  async upsertBoardObject(
    boardId: string,
    objectId: string,
    objectData: BoardLayoutObject,
    _params?: BoardParams
  ): Promise<Board> {
    return this.boardRepo.upsertBoardObject(boardId, objectId, objectData);
  }

  /**
   * Remove a board object atomically
   */
  async removeBoardObject(
    boardId: string,
    objectId: string,
    _params?: BoardParams
  ): Promise<Board> {
    return this.boardRepo.removeBoardObject(boardId, objectId);
  }

  /**
   * Batch upsert board objects (e.g., for drag end with multiple position updates)
   */
  async batchUpsertBoardObjects(
    boardId: string,
    objects: Record<string, BoardLayoutObject>,
    _params?: BoardParams
  ): Promise<Board> {
    return this.boardRepo.batchUpsertBoardObjects(boardId, objects);
  }
}
```

### FeathersJS Routes

```typescript
// apps/agor-daemon/src/index.ts

app.service('boards').hooks({
  before: {
    // Allow custom methods via patch with _action field
    patch: [
      async context => {
        const { _action, objectId, objectData, objects } = context.data || {};

        if (_action === 'upsertObject' && objectId && objectData) {
          const result = await context.service.upsertBoardObject(context.id, objectId, objectData);
          context.result = result;
          return context;
        }

        if (_action === 'removeObject' && objectId) {
          const result = await context.service.removeBoardObject(context.id, objectId);
          context.result = result;
          return context;
        }

        if (_action === 'batchUpsertObjects' && objects) {
          const result = await context.service.batchUpsertBoardObjects(context.id, objects);
          context.result = result;
          return context;
        }

        return context;
      },
    ],
  },
});
```

---

## Client Usage

### SessionCanvas - Drag End Handler (Updated)

```typescript
// apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx

const handleNodeDragStop: NodeDragHandler = useCallback(
  async (_event, node) => {
    if (!board || !client) return;

    // Track final position locally
    localPositionsRef.current[node.id] = {
      x: node.position.x,
      y: node.position.y,
    };

    // Accumulate position updates
    pendingLayoutUpdatesRef.current[node.id] = {
      x: node.position.x,
      y: node.position.y,
    };

    // Clear existing timer
    if (layoutUpdateTimerRef.current) {
      clearTimeout(layoutUpdateTimerRef.current);
    }

    // Debounce: wait 500ms after last drag before persisting
    layoutUpdateTimerRef.current = setTimeout(async () => {
      const updates = pendingLayoutUpdatesRef.current;
      pendingLayoutUpdatesRef.current = {};
      isDraggingRef.current = false;

      try {
        // ✅ NEW: Atomic batch upsert (safe for concurrent updates)
        const objectsToUpdate: Record<string, BoardLayoutObject> = {};

        for (const [objectId, position] of Object.entries(updates)) {
          objectsToUpdate[objectId] = {
            type: 'session', // Or determine from node type
            x: position.x,
            y: position.y,
          };
        }

        await client.service('boards').patch(board.board_id, {
          _action: 'batchUpsertObjects',
          objects: objectsToUpdate,
        });

        console.log('✓ Layout persisted:', Object.keys(updates).length, 'objects');
      } catch (error) {
        console.error('Failed to persist layout:', error);
      }
    }, 500);
  },
  [board, client]
);
```

### Adding New Objects

```typescript
// apps/agor-ui/src/components/BoardSidebar/BoardSidebar.tsx

const addTextNode = async () => {
  if (!board || !client) return;

  const objectId = `text-${Date.now()}`; // Or use generateId() for UUIDv7
  const position = screenToFlowPosition({ x: 200, y: 200 });

  // Add to local state immediately (optimistic UI)
  setNodes(nodes => [
    ...nodes,
    {
      id: objectId,
      type: 'text',
      position,
      data: { content: 'New text...', fontSize: 16 },
      draggable: true,
    },
  ]);

  // Persist atomically
  try {
    await client.service('boards').patch(board.board_id, {
      _action: 'upsertObject',
      objectId,
      objectData: {
        type: 'text',
        x: position.x,
        y: position.y,
        content: 'New text...',
        fontSize: 16,
      },
    });
  } catch (error) {
    console.error('Failed to add text node:', error);
    // Rollback optimistic update
    setNodes(nodes => nodes.filter(n => n.id !== objectId));
  }
};
```

### Deleting Objects

```typescript
const deleteObject = async (objectId: string) => {
  if (!board || !client) return;

  // Remove from local state (optimistic)
  setNodes(nodes => nodes.filter(n => n.id !== objectId));

  // Persist deletion
  try {
    await client.service('boards').patch(board.board_id, {
      _action: 'removeObject',
      objectId,
    });
  } catch (error) {
    console.error('Failed to delete object:', error);
    // TODO: Rollback or show error
  }
};
```

---

## Floating Toolbox UI

### Overview

React Flow doesn't provide a built-in toolbox component, but it offers **Panel** and **Controls** components that make it easy to create a persistent floating toolbar.

**Difficulty:** ⭐ Easy (10-15 minutes of work)

### Approach: Extend React Flow Controls

React Flow's `<Controls />` component (already in SessionCanvas.tsx:262) can be extended with custom buttons:

```typescript
import { Controls, ControlButton } from 'reactflow';
import { FontSizeOutlined, BorderOutlined, DeleteOutlined } from '@ant-design/icons';

<Controls>
  {/* Built-in controls: zoom, fit view, etc. */}
  <ControlButton onClick={handleAddText} title="Add Text">
    <FontSizeOutlined />
  </ControlButton>
  <ControlButton onClick={handleAddZone} title="Add Zone">
    <BorderOutlined />
  </ControlButton>
  <ControlButton onClick={handleDelete} title="Delete Selected">
    <DeleteOutlined />
  </ControlButton>
</Controls>
```

**Pros:**

- ✅ Matches existing UI (Controls already used for zoom/fit)
- ✅ Built-in positioning and styling
- ✅ Mobile-friendly
- ✅ No extra dependencies

**Cons:**

- ❌ Limited customization (icon buttons only, no labels)
- ❌ Vertical layout only

### Alternative: Custom Panel Toolbox

For more flexibility, use React Flow's `<Panel />` component:

```typescript
import { Panel } from 'reactflow';
import { Button, Tooltip } from 'antd';

<Panel position="top-center">
  <div style={{
    display: 'flex',
    gap: '8px',
    padding: '8px',
    background: 'white',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
  }}>
    <Tooltip title="Add Text (T)">
      <Button
        icon={<FontSizeOutlined />}
        onClick={handleAddText}
        type={activeTool === 'text' ? 'primary' : 'default'}
      />
    </Tooltip>
    <Tooltip title="Add Zone (Z)">
      <Button
        icon={<BorderOutlined />}
        onClick={handleAddZone}
        type={activeTool === 'zone' ? 'primary' : 'default'}
      />
    </Tooltip>
    <Tooltip title="Eraser (E)">
      <Button
        icon={<DeleteOutlined />}
        onClick={handleActivateEraser}
        type={activeTool === 'eraser' ? 'primary' : 'default'}
        danger={activeTool === 'eraser'}
      />
    </Tooltip>
  </div>
</Panel>
```

**Panel Positions:** `top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center`, `bottom-right`

**Pros:**

- ✅ Full Ant Design component library
- ✅ Active tool highlighting
- ✅ Custom positioning
- ✅ Horizontal layout

### Recommended Implementation

**Phase 1: Extend Controls (Quick Win)**

```typescript
// apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx

import { Controls, ControlButton } from 'reactflow';
import { FontSizeOutlined, BorderOutlined, DeleteOutlined } from '@ant-design/icons';

const SessionCanvas = ({ ... }) => {
  const [activeTool, setActiveTool] = useState<'select' | 'text' | 'zone' | 'eraser'>('select');

  const handleAddText = () => {
    setActiveTool('text');
    // User clicks canvas to place text node
  };

  const handleAddZone = () => {
    setActiveTool('zone');
    // User clicks canvas to place zone node
  };

  const handleEraser = () => {
    setActiveTool('eraser');
    // User clicks nodes to delete them
  };

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <ReactFlow ...>
        <Background />
        <Controls>
          <ControlButton
            onClick={handleAddText}
            title="Add Text (T)"
            style={{ borderLeft: activeTool === 'text' ? '3px solid #1677ff' : 'none' }}
          >
            <FontSizeOutlined />
          </ControlButton>
          <ControlButton
            onClick={handleAddZone}
            title="Add Zone (Z)"
            style={{ borderLeft: activeTool === 'zone' ? '3px solid #1677ff' : 'none' }}
          >
            <BorderOutlined />
          </ControlButton>
          <ControlButton
            onClick={handleEraser}
            title="Eraser (E)"
            style={{
              borderLeft: activeTool === 'eraser' ? '3px solid #ff4d4f' : 'none',
              color: activeTool === 'eraser' ? '#ff4d4f' : 'inherit',
            }}
          >
            <DeleteOutlined />
          </ControlButton>
        </Controls>
        <MiniMap ... />
      </ReactFlow>
    </div>
  );
};
```

### Tool Interaction Patterns

**1. Click-to-Place (Recommended)**

```typescript
const handleCanvasClick = useCallback((event: React.MouseEvent) => {
  if (activeTool === 'select') return;

  const bounds = event.currentTarget.getBoundingClientRect();
  const position = reactFlowInstance.screenToFlowPosition({
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  });

  if (activeTool === 'text') {
    addTextNode(position);
    setActiveTool('select'); // Return to select mode
  } else if (activeTool === 'zone') {
    addZoneNode(position);
    setActiveTool('select');
  }
}, [activeTool, reactFlowInstance]);

<div onClick={handleCanvasClick} style={{ width: '100%', height: '100vh' }}>
  <ReactFlow ...>
```

**2. Eraser Mode**

```typescript
const handleNodeClick = useCallback((event, node) => {
  if (activeTool === 'eraser') {
    deleteObject(node.id);
    return;
  }

  // Normal node click (open drawer, etc.)
  onSessionClick?.(node.id);
}, [activeTool]);

<ReactFlow
  onNodeClick={handleNodeClick}
  ...
>
```

**3. Keyboard Shortcuts**

```typescript
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 't') setActiveTool('text');
    if (e.key === 'z') setActiveTool('zone');
    if (e.key === 'e') setActiveTool('eraser');
    if (e.key === 'Escape') setActiveTool('select');
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // Delete selected nodes
      const selectedNodes = nodes.filter(n => n.selected);
      selectedNodes.forEach(n => deleteObject(n.id));
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [nodes]);
```

### Cursor Styles

Update cursor based on active tool:

```typescript
<div style={{
  width: '100%',
  height: '100vh',
  cursor: activeTool === 'text' ? 'text' :
          activeTool === 'zone' ? 'crosshair' :
          activeTool === 'eraser' ? 'not-allowed' :
          'default',
}}>
  <ReactFlow ...>
</div>
```

---

## React Flow Integration

### Custom Node Types

```typescript
// apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx

const TextNode = ({ id, data }: { id: string; data: { content: string; fontSize?: number; color?: string; background?: string } }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [content, setContent] = useState(data.content);

  const handleSave = async () => {
    setIsEditing(false);
    // Update via atomic upsert
    await client.service('boards').patch(board.board_id, {
      _action: 'upsertObject',
      objectId: id,
      objectData: {
        ...data,
        content,
      },
    });
  };

  return (
    <div
      style={{
        padding: '8px 12px',
        fontSize: data.fontSize || 16,
        color: data.color || '#000',
        background: data.background || 'transparent',
        border: '1px solid #d9d9d9',
        borderRadius: '4px',
        minWidth: '100px',
        cursor: isEditing ? 'text' : 'move',
      }}
      onDoubleClick={() => setIsEditing(true)}
    >
      {isEditing ? (
        <input
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          autoFocus
        />
      ) : (
        content
      )}
    </div>
  );
};

const ZoneNode = ({ data }: { data: { label: string; width: number; height: number; color?: string; status?: string } }) => (
  <div
    style={{
      width: data.width,
      height: data.height,
      border: `2px dashed ${data.color || '#d9d9d9'}`,
      borderRadius: '8px',
      background: data.color ? `${data.color}10` : 'transparent', // 10% opacity
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      pointerEvents: 'none', // Let sessions behind zone be clickable
      zIndex: -1, // Zones always behind sessions
    }}
  >
    <div style={{ pointerEvents: 'auto' }}>
      <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>{data.label}</h3>
    </div>
  </div>
);

const nodeTypes = {
  sessionNode: SessionNode,
  text: TextNode,
  zone: ZoneNode,
};
```

### Sidebar with Object Palette

```typescript
// apps/agor-ui/src/components/BoardSidebar/BoardSidebar.tsx

import { PlusOutlined, FontSizeOutlined, BorderOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { useReactFlow } from 'reactflow';

interface BoardSidebarProps {
  board: Board | null;
  client: AgorClient | null;
}

const BoardSidebar = ({ board, client }: BoardSidebarProps) => {
  const { screenToFlowPosition, setNodes } = useReactFlow();

  const addTextNode = async () => {
    if (!board || !client) return;

    const objectId = `text-${Date.now()}`;
    const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

    // Optimistic UI
    setNodes((nodes) => [
      ...nodes,
      {
        id: objectId,
        type: 'text',
        position,
        data: { content: 'New text...', fontSize: 16 },
        draggable: true,
      },
    ]);

    // Persist
    await client.service('boards').patch(board.board_id, {
      _action: 'upsertObject',
      objectId,
      objectData: {
        type: 'text',
        x: position.x,
        y: position.y,
        content: 'New text...',
        fontSize: 16,
      },
    });
  };

  const addZoneNode = async () => {
    if (!board || !client) return;

    const objectId = `zone-${Date.now()}`;
    const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

    // Optimistic UI
    setNodes((nodes) => [
      ...nodes,
      {
        id: objectId,
        type: 'zone',
        position,
        data: { label: 'New Zone', width: 400, height: 600, color: '#d9d9d9' },
        draggable: true,
      },
    ]);

    // Persist
    await client.service('boards').patch(board.board_id, {
      _action: 'upsertObject',
      objectId,
      objectData: {
        type: 'zone',
        x: position.x,
        y: position.y,
        width: 400,
        height: 600,
        label: 'New Zone',
        color: '#d9d9d9',
      },
    });
  };

  return (
    <div style={{
      padding: '16px',
      borderRight: '1px solid #d9d9d9',
      width: '200px',
      background: '#fafafa',
    }}>
      <h3 style={{ marginBottom: '16px' }}>Add Objects</h3>
      <Button
        icon={<FontSizeOutlined />}
        onClick={addTextNode}
        block
        style={{ marginBottom: '8px' }}
      >
        Text Label
      </Button>
      <Button
        icon={<BorderOutlined />}
        onClick={addZoneNode}
        block
      >
        Zone
      </Button>
    </div>
  );
};

export default BoardSidebar;
```

---

## Resizing Support

### Install Node Resizer

```bash
pnpm add @reactflow/node-resizer
```

### Wrap Resizable Nodes

```typescript
// apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx

import { NodeResizer } from '@reactflow/node-resizer';
import '@reactflow/node-resizer/dist/style.css';

const ZoneNode = ({ id, data, selected }: { id: string; data: ZoneData; selected: boolean }) => {
  const { getNode } = useReactFlow();

  const handleResizeStop = async () => {
    const node = getNode(id);
    if (!node || !board || !client) return;

    // Update dimensions atomically
    await client.service('boards').patch(board.board_id, {
      _action: 'upsertObject',
      objectId: id,
      objectData: {
        ...data,
        width: node.width || data.width,
        height: node.height || data.height,
      },
    });
  };

  return (
    <>
      {selected && (
        <NodeResizer
          minWidth={200}
          minHeight={200}
          onResizeEnd={handleResizeStop}
        />
      )}
      <div style={{ width: '100%', height: '100%', ... }}>
        {/* Zone content */}
      </div>
    </>
  );
};
```

---

## Kanban Triggers (Zone Drop Detection)

Use React Flow's `getIntersectingNodes()` for collision detection:

```typescript
// apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx

const handleNodeDragStop = async (event, node) => {
  if (!board || !client) return;

  // 1. Persist position (existing logic)
  await client.service('boards').patch(board.board_id, {
    _action: 'upsertObject',
    objectId: node.id,
    objectData: {
      type: node.type === 'sessionNode' ? 'session' : node.data.type,
      x: node.position.x,
      y: node.position.y,
      ...node.data,
    },
  });

  // 2. NEW: Check if session dropped in a zone
  if (node.type === 'sessionNode') {
    const intersections = reactFlowInstance.getIntersectingNodes(node);
    const zone = intersections.find(n => n.type === 'zone' && n.data.status);

    if (zone) {
      // Session dropped in a status zone - update session status
      await client.service('sessions').patch(node.id, {
        status: zone.data.status, // e.g., 'running', 'completed'
      });

      console.log(`✓ Session ${node.id} moved to ${zone.data.status}`);
    }
  }
};
```

---

## Implementation Checklist

### Phase 1: Basic Infrastructure

- [ ] Add `objects` field to Board type with discriminated union
- [ ] Implement `upsertBoardObject()` in BoardRepository with `json_set()`
- [ ] Implement `removeBoardObject()` in BoardRepository with `json_remove()`
- [ ] Add service methods to BoardsService
- [ ] Add FeathersJS hook to handle `_action` parameter
- [ ] Update SessionCanvas to use atomic upserts instead of full layout replace

### Phase 2: Text Nodes

- [ ] Create `TextNode` component with inline editing
- [ ] Add `BoardSidebar` with "Add Text" button
- [ ] Implement text content editing with atomic updates
- [ ] Add delete button/context menu for text nodes

### Phase 3: Zone Nodes

- [ ] Create `ZoneNode` component with configurable size/color
- [ ] Add "Add Zone" button to sidebar
- [ ] Install `@reactflow/node-resizer` and make zones resizable
- [ ] Persist size changes with atomic updates
- [ ] Add zone settings modal (color picker, label, status)

### Phase 4: Kanban Triggers

- [ ] Add `status` field to zone data
- [ ] Implement `getIntersectingNodes()` in `handleNodeDragStop`
- [ ] Update session status when dropped in zone
- [ ] Add visual feedback (zone highlight on hover, toast notification)

### Phase 5: Floating Toolbox

- [ ] Add `activeTool` state to SessionCanvas
- [ ] Extend `<Controls>` with `<ControlButton>` for text/zone/eraser
- [ ] Implement click-to-place interaction for text and zone tools
- [ ] Implement eraser mode (click nodes to delete)
- [ ] Add keyboard shortcuts (T, Z, E, Escape, Delete)
- [ ] Update cursor style based on active tool

### Phase 6: Polish

- [ ] Drag-and-drop from sidebar (HTML Drag API or pointer events)
- [ ] Color picker for zones
- [ ] Font size/color controls for text
- [ ] Context menu for all object types
- [ ] Multi-select and bulk operations
- [ ] Undo/redo support

---

## Migration Path: `layout` → `objects`

**Backward Compatibility:**

During transition, support both `layout` and `objects`:

```typescript
// Backend: BoardRepository.rowToBoard()
private rowToBoard(row: BoardRow): Board {
  const data = row.data;

  // Migrate layout → objects if needed
  let objects = data.objects || {};
  if (data.layout && Object.keys(data.layout).length > 0) {
    // Auto-migrate session positions to objects
    for (const [sessionId, position] of Object.entries(data.layout)) {
      if (!objects[sessionId]) {
        objects[sessionId] = { type: 'session', ...position };
      }
    }
  }

  return {
    board_id: row.board_id,
    // ...
    objects,
    layout: data.layout, // Keep for backward compat
  };
}
```

**Deprecation Timeline:**

1. **Phase 1:** Add `objects` field, dual-write to both
2. **Phase 2:** Migrate existing `layout` data to `objects` (one-time script)
3. **Phase 3:** Update all clients to use `objects`
4. **Phase 4:** Remove `layout` field (breaking change, major version)

---

## Future Enhancements

### Rich Text Support

- Use `react-quill` or `@tiptap/react` for formatted text
- Support markdown rendering
- Inline images

### Additional Object Types

- **Arrows** - Custom edge components with labels
- **Shapes** - Circles, triangles, icons
- **Embedded Files** - PDFs, images, code snippets via iframe
- **Links** - External URLs with preview cards

### Collaboration Features

- Real-time collaborative editing (CRDT-based)
- Comments on objects
- Object permissions (who can edit)
- Version history

### Migration to Separate Table (If Needed)

When objects become too complex:

1. Create `board_objects` table
2. Migrate data from `boards.data.objects`
3. Update services to use new table
4. Keep atomic update pattern (now row-level instead of JSON key-level)

---

## Open Questions

1. **ID Generation:** Use UUIDv7 or simple prefixes (`text-{timestamp}`)?
   - **Recommendation:** UUIDv7 for consistency, easier migration to separate table later

2. **Editing UX:** Inline contentEditable or Modal dialogs?
   - **Recommendation:** Inline for text (double-click), Modal for zones (settings icon)

3. **Z-Index Management:** How to control layer order?
   - **Recommendation:** Zones always behind sessions (`zIndex: -1`), add `zIndex` field to objects for custom ordering later

4. **Delete Confirmation:** Always confirm or only for certain types?
   - **Recommendation:** No confirmation for now (can undo with Cmd+Z later), add trash/restore later

5. **Batch vs Single Updates:** Always batch or support both?
   - **Recommendation:** Support both - single for immediate updates, batch for drag debouncing

---

## References

- **React Flow Docs:** https://reactflow.dev/examples/interaction/drag-and-drop
- **Node Resizer:** https://reactflow.dev/examples/nodes/node-resizer
- **Collision Detection:** https://reactflow.dev/examples/interaction/collision-detection
- **SQLite JSON Functions:** https://www.sqlite.org/json1.html
- **SQLite Concurrency:** https://www.sqlite.org/lockingv3.html
