# Board Export/Import (Shell Only)

**Status:** 🧪 Exploration
**Related:** [board-objects.md](../concepts/board-objects.md), [models.md](../concepts/models.md), [worktrees.md](../concepts/worktrees.md)

---

## Overview

Allow users to **export** and **import** board layouts as portable files. This enables:

- **Template sharing** - Share board layouts (zones, annotations) across teams
- **Board cloning** - Duplicate existing boards as starting points
- **Backup/restore** - Save board configurations for archival or migration
- **Version control** - Track board layout evolution in git

**Important:** Export/import is **shell-only** - it includes board metadata and annotations (zones, text, markdown), but **not** the actual worktrees or sessions. The exported board is an empty template that can be populated with new work.

---

## Scope

### What Gets Exported ✅

From the `Board` model:

```typescript
{
  // Core metadata
  name: string
  slug?: string
  description?: string
  icon?: string
  color?: string
  background_color?: string

  // Annotations (zones, text, markdown notes)
  objects?: {
    [objectId: string]: BoardObject  // Zones, text labels, markdown
  }

  // Custom context for templates
  custom_context?: Record<string, unknown>
}
```

### What Gets Excluded ❌

- **Worktrees** - Not exported (worktree references in `board_objects` table)
- **Sessions** - Not exported (sessions belong to worktrees)
- **Board entity objects** - Not exported (positioned worktrees on canvas)
- **User attribution** - `created_by`, `created_at`, `last_updated` are regenerated on import
- **Board ID** - New UUIDv7 generated on import

**Rationale:** Boards are templates/layouts, not data containers. Worktrees and sessions are workspace-specific and don't make sense to export across machines or users.

---

## File Formats

### YAML Format (Human-Readable)

```yaml
# Agor Board Export
# Generated: 2025-01-20T10:30:00Z
# Version: 1.0

name: Sprint Planning Board
slug: sprint-planning
description: Template for sprint planning with backlog, in-progress, and review zones
icon: 🚀
color: '#1677ff'
background_color: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'

# Custom context (available in zone triggers via {{ board.context.* }})
custom_context:
  team: Backend
  sprint: 42
  sprint_start: '2025-01-20'
  sprint_end: '2025-02-03'

# Board objects (zones, annotations)
objects:
  zone-backlog:
    type: zone
    x: 100
    y: 100
    width: 400
    height: 600
    label: 📋 Backlog
    borderColor: '#1890ff'
    backgroundColor: 'rgba(24, 144, 255, 0.1)'
    locked: false
    trigger:
      behavior: show_picker
      template: |
        Implement the following feature:
        Issue: {{ worktree.issue_url }}
        Sprint: {{ board.context.sprint }}

  zone-in-progress:
    type: zone
    x: 550
    y: 100
    width: 400
    height: 600
    label: 🏗️ In Progress
    borderColor: '#faad14'
    backgroundColor: 'rgba(250, 173, 20, 0.1)'
    locked: false

  zone-review:
    type: zone
    x: 1000
    y: 100
    width: 400
    height: 600
    label: 👀 Review
    borderColor: '#52c41a'
    backgroundColor: 'rgba(82, 196, 26, 0.1)'
    locked: false
    trigger:
      behavior: always_new
      template: |
        Review PR: {{ worktree.pull_request_url }}
        Check for:
        - Code quality
        - Test coverage
        - Documentation

  text-instructions:
    type: text
    x: 100
    y: 50
    width: 1300
    content: 'Drag worktrees through the zones as work progresses →'
    fontSize: 16
    color: '#ffffff'

  markdown-guidelines:
    type: markdown
    x: 1450
    y: 100
    width: 350
    content: |
      # Sprint Guidelines

      ## Definition of Done
      - [ ] Code reviewed
      - [ ] Tests passing
      - [ ] Docs updated
      - [ ] Deployed to staging

      ## Resources
      - [Sprint Planning Doc](https://...)
      - [Team Runbook](https://...)
```

### JSON Format (Machine-Readable)

Same structure as YAML, but in JSON format for programmatic use:

```json
{
  "name": "Sprint Planning Board",
  "slug": "sprint-planning",
  "description": "Template for sprint planning...",
  "icon": "🚀",
  "objects": {
    "zone-backlog": { ... }
  }
}
```

**File naming conventions:**

- YAML: `{slug}.agor-board.yaml` or `{name}-board.yaml`
- JSON: `{slug}.agor-board.json` or `{name}-board.json`

---

## API Design

### BoardsService Extensions

Add four new methods to `BoardsService` (`apps/agor-daemon/src/services/boards.ts`):

```typescript
export class BoardsService extends DrizzleService<Board, Partial<Board>, BoardParams> {
  /**
   * Export board to blob (JSON)
   *
   * Strips runtime-specific fields (IDs, timestamps, user attribution).
   * Returns a portable board template.
   */
  async toBlob(boardId: string): Promise<BoardExportBlob> {
    const board = await this.get(boardId);

    return {
      name: board.name,
      slug: board.slug,
      description: board.description,
      icon: board.icon,
      color: board.color,
      background_color: board.background_color,
      objects: board.objects,
      custom_context: board.custom_context,
    };
  }

  /**
   * Import board from blob (JSON)
   *
   * Creates a new board with fresh IDs and timestamps.
   * Returns the created board.
   */
  async fromBlob(blob: BoardExportBlob, userId: string): Promise<Board> {
    // Validate blob structure
    if (!blob.name) {
      throw new Error('Board name is required');
    }

    // Ensure unique slug (append -copy, -copy-2, etc.)
    let slug = blob.slug;
    if (slug) {
      slug = await this.getUniqueSlug(slug);
    }

    // Create new board with fresh IDs
    return this.create({
      name: blob.name,
      slug,
      description: blob.description,
      icon: blob.icon,
      color: blob.color,
      background_color: blob.background_color,
      objects: blob.objects,
      custom_context: blob.custom_context,
      created_by: userId,
    });
  }

  /**
   * Export board to YAML string
   */
  async toYaml(boardId: string): Promise<string> {
    const blob = await this.toBlob(boardId);

    // Add header comment with metadata
    const header = [
      '# Agor Board Export',
      `# Generated: ${new Date().toISOString()}`,
      '# Version: 1.0',
      '',
    ].join('\n');

    return header + yaml.stringify(blob);
  }

  /**
   * Import board from YAML string
   */
  async fromYaml(yamlContent: string, userId: string): Promise<Board> {
    try {
      const blob = yaml.parse(yamlContent) as BoardExportBlob;
      return this.fromBlob(blob, userId);
    } catch (error) {
      throw new Error(`Failed to parse YAML: ${error.message}`);
    }
  }

  /**
   * Clone board (create copy with new ID)
   *
   * Convenience method that combines toBlob + fromBlob.
   */
  async clone(boardId: string, newName: string, userId: string): Promise<Board> {
    const blob = await this.toBlob(boardId);
    blob.name = newName;

    // Generate slug from name if original had slug
    if (blob.slug) {
      blob.slug = this.slugify(newName);
    }

    return this.fromBlob(blob, userId);
  }

  // Helper methods

  private async getUniqueSlug(baseSlug: string): Promise<string> {
    let slug = baseSlug;
    let counter = 1;

    while (await this.findBySlug(slug)) {
      slug = `${baseSlug}-copy${counter > 1 ? `-${counter}` : ''}`;
      counter++;
    }

    return slug;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
```

### Type Definitions

Add to `packages/core/src/types/board.ts`:

```typescript
/**
 * Portable board export format (shell only)
 *
 * Contains board metadata and annotations, but no worktrees or sessions.
 * Can be serialized to YAML/JSON for sharing or archival.
 */
export interface BoardExportBlob {
  // Core metadata
  name: string;
  slug?: string;
  description?: string;
  icon?: string;
  color?: string;
  background_color?: string;

  // Annotations (zones, text, markdown)
  objects?: {
    [objectId: string]: BoardObject;
  };

  // Custom context for templates
  custom_context?: Record<string, unknown>;
}
```

---

## UI Design

### BoardsTable Component Updates

Add three new action buttons to each board row in the boards table (`apps/agor-ui/src/components/SettingsModal/BoardsTable.tsx`):

```typescript
{
  title: 'Actions',
  key: 'actions',
  width: 200,
  render: (_: unknown, board: Board) => (
    <Space size="small">
      <Button
        type="text"
        size="small"
        icon={<CopyOutlined />}
        onClick={() => handleClone(board)}
        title="Clone board"
      />
      <Button
        type="text"
        size="small"
        icon={<DownloadOutlined />}
        onClick={() => handleExport(board)}
        title="Export board"
      />
      <Button
        type="text"
        size="small"
        icon={<UploadOutlined />}
        onClick={() => handleImportClick()}
        title="Import board"
      />
      <Button
        type="text"
        size="small"
        icon={<EditOutlined />}
        onClick={() => handleEdit(board)}
      />
      <Popconfirm
        title="Delete board?"
        description={`Are you sure you want to delete "${board.name}"?`}
        onConfirm={() => handleDelete(board.board_id)}
        okText="Delete"
        cancelText="Cancel"
        okButtonProps={{ danger: true }}
      >
        <Button type="text" size="small" icon={<DeleteOutlined />} danger />
      </Popconfirm>
    </Space>
  ),
}
```

### Action Handlers

```typescript
// Clone board (inline prompt for new name)
const handleClone = (board: Board) => {
  Modal.confirm({
    title: 'Clone Board',
    content: (
      <Input
        placeholder="New board name"
        defaultValue={`${board.name} (Copy)`}
        id="clone-board-name"
      />
    ),
    onOk: async () => {
      const input = document.getElementById('clone-board-name') as HTMLInputElement;
      const newName = input.value || `${board.name} (Copy)`;

      const clonedBoard = await api.service('boards').clone(board.board_id, newName);
      message.success(`Board cloned: ${clonedBoard.name}`);
    },
  });
};

// Export board (download YAML file)
const handleExport = async (board: Board) => {
  const yaml = await api.service('boards').toYaml(board.board_id);

  // Trigger download
  const blob = new Blob([yaml], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${board.slug || board.name}.agor-board.yaml`;
  a.click();
  URL.revokeObjectURL(url);

  message.success('Board exported');
};

// Import board (file picker dialog)
const handleImportClick = () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.yaml,.yml,.json';
  input.onchange = (e) => handleImportFile((e.target as HTMLInputElement).files?.[0]);
  input.click();
};

const handleImportFile = async (file: File | undefined) => {
  if (!file) return;

  const content = await file.text();

  try {
    let board: Board;

    if (file.name.endsWith('.json')) {
      board = await api.service('boards').fromBlob(JSON.parse(content));
    } else {
      board = await api.service('boards').fromYaml(content);
    }

    message.success(`Board imported: ${board.name}`);
  } catch (error) {
    message.error(`Import failed: ${error.message}`);
  }
};
```

### UX Flow

**Export:**

1. User clicks "Export" button on board row
2. YAML file downloads immediately (no modal needed)
3. Toast: "Board exported"

**Import:**

1. User clicks "Import" button (top-level, not per-board)
2. File picker opens (accepts `.yaml`, `.yml`, `.json`)
3. User selects file
4. Board is created with unique slug
5. Toast: "Board imported: {name}"
6. Table updates to show new board

**Clone:**

1. User clicks "Clone" button on board row
2. Modal prompts for new board name (pre-filled with "{original} (Copy)")
3. User confirms
4. New board created with cloned layout
5. Toast: "Board cloned: {name}"
6. Table updates to show new board

---

## CLI Support

Add CLI commands for scripting and automation:

### `agor board export`

```bash
# Export board to YAML
agor board export <board-id-or-slug> -o sprint-planning.yaml

# Export to JSON
agor board export <board-id-or-slug> -o sprint-planning.json --format json

# Export to stdout (for piping)
agor board export <board-id-or-slug>
```

### `agor board import`

```bash
# Import from file
agor board import sprint-planning.yaml

# Import from stdin (for piping)
cat sprint-planning.yaml | agor board import
```

### `agor board clone`

```bash
# Clone existing board with new name
agor board clone <board-id-or-slug> "Sprint 43 Planning"
```

**Implementation location:** `apps/agor-cli/src/commands/board/`

---

## Implementation Checklist

### Phase 1: Core API (Backend)

- [ ] Add `BoardExportBlob` type to `packages/core/src/types/board.ts`
- [ ] Install `js-yaml` dependency (`pnpm add js-yaml && pnpm add -D @types/js-yaml`)
- [ ] Add `toBlob()` method to `BoardRepository`
- [ ] Add `fromBlob()` method to `BoardRepository` with slug uniqueness logic
- [ ] Add `toYaml()` method to `BoardRepository`
- [ ] Add `fromYaml()` method to `BoardRepository`
- [ ] Add `clone()` method to `BoardRepository`
- [ ] Expose new methods in `BoardsService`
- [ ] Add validation for imported board structure

### Phase 2: UI (Frontend)

- [ ] Add clone/export/import icons to `BoardsTable` actions column
- [ ] Implement `handleClone()` with name prompt modal
- [ ] Implement `handleExport()` with YAML download
- [ ] Implement `handleImportClick()` with file picker
- [ ] Implement `handleImportFile()` with error handling
- [ ] Add "Import Board" button at table level (next to "New Board")
- [ ] Add toast notifications for all operations
- [ ] Handle import errors gracefully (invalid YAML, missing required fields)

### Phase 3: CLI

- [ ] Create `apps/agor-cli/src/commands/board/export.ts`
- [ ] Create `apps/agor-cli/src/commands/board/import.ts`
- [ ] Create `apps/agor-cli/src/commands/board/clone.ts`
- [ ] Add `-o/--output` flag for export command
- [ ] Add `--format` flag for export (yaml/json)
- [ ] Support stdin/stdout for piping
- [ ] Add validation and error messages

### Phase 4: Documentation

- [ ] Update `context/concepts/board-objects.md` with export/import section
- [ ] Add YAML format example to docs
- [ ] Add CLI usage examples
- [ ] Document use cases (templates, backups, version control)

---

## Use Cases

### 1. Team Templates

Share standardized board layouts across team members:

```bash
# Team lead creates template
agor board export sprint-planning -o sprint-template.yaml
git add sprint-template.yaml
git commit -m "Add sprint planning board template"
git push

# Team member imports template
git pull
agor board import sprint-template.yaml
```

### 2. Board Iteration

Evolve board layouts over time while preserving history:

```bash
# Clone current board to experiment
agor board clone sprint-42 "Sprint 42 (Experiment)"

# Make changes in UI...

# If experiment works, replace original
agor board export sprint-42-experiment -o sprint-template-v2.yaml
```

### 3. Migration/Backup

Archive board configurations before major changes:

```bash
# Backup all boards
for board in $(agor board list --json | jq -r '.[].board_id'); do
  agor board export $board -o "backup-$(date +%Y%m%d)-$board.yaml"
done
```

### 4. Board Library

Maintain a library of reusable board templates:

```yaml
# boards/kanban.yaml
name: Kanban Board
objects:
  zone-todo: { ... }
  zone-doing: { ... }
  zone-done: { ... }

# boards/sprint-planning.yaml
name: Sprint Planning
objects:
  zone-backlog: { ... }
  zone-sprint: { ... }
  zone-review: { ... }
```

Users can import templates as needed from a shared repo.

---

## Edge Cases & Validation

### Import Validation

Check for required fields and valid structure:

```typescript
function validateBoardBlob(blob: unknown): BoardExportBlob {
  if (!blob || typeof blob !== 'object') {
    throw new Error('Invalid board export: must be an object');
  }

  const b = blob as Partial<BoardExportBlob>;

  if (!b.name || typeof b.name !== 'string') {
    throw new Error('Invalid board export: name is required');
  }

  // Validate objects structure
  if (b.objects) {
    for (const [id, obj] of Object.entries(b.objects)) {
      if (!obj.type || !['zone', 'text', 'markdown'].includes(obj.type)) {
        throw new Error(`Invalid object ${id}: unsupported type`);
      }

      // Type-specific validation
      if (obj.type === 'zone') {
        if (
          typeof obj.x !== 'number' ||
          typeof obj.y !== 'number' ||
          typeof obj.width !== 'number' ||
          typeof obj.height !== 'number'
        ) {
          throw new Error(`Invalid zone ${id}: missing position/dimensions`);
        }
      }
    }
  }

  return b as BoardExportBlob;
}
```

### Slug Conflicts

When importing a board with a slug that already exists:

- Append `-copy` to slug (e.g., `sprint-planning` → `sprint-planning-copy`)
- If that exists, try `-copy-2`, `-copy-3`, etc.
- Always ensure uniqueness before creating board

### Object ID Preservation

**Keep original object IDs** during import/clone:

- Zone IDs like `zone-backlog` should remain stable across imports
- This allows users to reference specific zones in documentation
- No need to regenerate IDs since they're scoped to the board

### Custom Context Validation

Custom context must be valid JSON:

```typescript
if (blob.custom_context) {
  try {
    // Ensure it's serializable
    JSON.parse(JSON.stringify(blob.custom_context));
  } catch (error) {
    throw new Error('Invalid custom_context: must be valid JSON');
  }
}
```

---

## Future Enhancements

### Export Options (Future)

Add flags to customize export scope:

```bash
# Export only zones (no text/markdown annotations)
agor board export sprint-42 --zones-only

# Export with comments explaining each field
agor board export sprint-42 --annotated
```

### Import Options (Future)

Add flags to customize import behavior:

```bash
# Merge objects into existing board (instead of creating new)
agor board import sprint-template.yaml --merge-into <board-id>

# Import as read-only template (locked zones)
agor board import sprint-template.yaml --lock-zones
```

### Version Detection (Future)

Add version field to exports for forward compatibility:

```yaml
# Agor Board Export
# Version: 1.1  # <-- Track format version

# If v1.1 adds new fields, v1.0 parser can ignore them gracefully
```

### Batch Operations (Future)

CLI commands for bulk operations:

```bash
# Export all boards to directory
agor board export-all -o ./board-backups/

# Import all YAML files from directory
agor board import-all ./board-templates/
```

---

## Summary

This feature enables board templates and layout sharing through a simple export/import system:

- **Shell-only exports** - Metadata and zones only, no worktrees/sessions
- **YAML & JSON formats** - Human-readable YAML for version control, JSON for programmatic use
- **Three operations** - Export (download), Import (upload), Clone (duplicate)
- **UI + CLI support** - Buttons in settings modal, CLI commands for scripting
- **Safe imports** - Slug uniqueness, validation, error handling

The implementation is straightforward since it only involves serializing/deserializing the existing `Board` structure minus runtime-specific fields.
