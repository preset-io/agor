# Rich Diff Viewer — Design Document

## Status: Ready for Implementation

---

## 1. What Data Do We Get from the SDK?

### Edit Tool Input Shape

```typescript
interface EditToolInput {
  file_path: string;      // Absolute path to the file
  old_string: string;     // Exact text to find and replace
  new_string: string;     // Replacement text
  replace_all?: boolean;  // Replace all occurrences (default: first only)
}
```

### Write Tool Input Shape

```typescript
interface WriteToolInput {
  file_path: string;      // Absolute path
  content: string;        // Full file content to write
}
```

### What the SDK Returns (tool_result)

**Edit:** `"The file /path/to/file.md has been updated successfully."`
**Write:** `"File created successfully at: /path/to/file.ts"`

No line numbers, no context lines, no diff. The rich CLI display is rendered locally.

### How Claude Code CLI Does It (from source analysis)

The CLI computes diffs **in-process** at edit time — not via `git diff`:

1. Reads file contents BEFORE the edit (`originalFile`)
2. Applies the replacement to get `updatedFile`
3. Calls `structuredPatch(filePath, filePath, originalFile, updatedFile, context=3)` using the `diff` npm library
4. Stores: `{ filePath, oldString, newString, originalFile, structuredPatch, replaceAll }`
5. Sends only `"The file X has been updated successfully."` back to the LLM

The `structuredPatch` returns hunks with line numbers:
```typescript
interface Hunk {
  oldStart: number;    // Line number in original file
  oldLines: number;
  newStart: number;    // Line number in new file
  newLines: number;
  lines: string[];     // Prefixed with +/-/space for context
}
```

**Key:** Each edit reads the CURRENT file (post any prior edits), so each diff block shows only that specific edit — no accumulation problem with multiple edits to the same file.

---

## 2. Architecture: Best-Effort Executor Enrichment + Client Fallback

### Strategy

The system works in two tiers:

1. **Executor enrichment (best effort):** When the executor processes a tool event, try to read the file and compute `structuredPatch`. Store it in the message's `data` JSONB. If this fails for any reason (file not accessible, race condition, executor doesn't support it yet), no problem.

2. **Client fallback (always works):** The UI renderer checks for `structuredPatch` in the message data. If present, render rich diff with line numbers and context. If absent, fall back to computing a simple `diffLines(old_string, new_string)` client-side — no line numbers, no context, but still syntax-highlighted and useful.

```
                    ┌─────────────────────────────┐
                    │     Executor (best effort)   │
                    │  Read file → structuredPatch │
                    │  Store in message.data JSONB │
                    └──────────┬──────────────────┘
                               │ (may or may not have enrichment)
                               ▼
┌──────────────────────────────────────────────────┐
│                  UI DiffBlock                     │
│                                                   │
│  Has structuredPatch?                             │
│  ├─ YES → Rich view: line numbers, context, hunks│
│  └─ NO  → Fallback: diffLines(old_string,        │
│            new_string) — no line numbers, still   │
│            syntax-highlighted                     │
└──────────────────────────────────────────────────┘
```

### Why Best-Effort?

- Executor may not have filesystem access in all configurations
- File read could fail (permissions, file deleted between events)
- We don't want to block or error the message pipeline over diff enrichment
- Old messages (before this feature) will never have enrichment — fallback covers them
- Keeps the feature shippable incrementally (UI first, executor second)

---

## 3. Executor Enrichment (Backend)

### Where to Hook In

The executor processes SDK events in `packages/executor/src/sdk-handlers/claude/`. When a `tool_result` for Edit/Write arrives (success, not error), we can enrich the message data before persisting.

### Data Shape (stored in message `data` JSONB)

```typescript
// Added to the message's data field alongside existing content
interface ToolResultEnrichment {
  diff?: {
    structuredPatch: Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: string[];        // +/-/space prefixed
    }>;
    originalFileExcerpt?: string;  // NOT the full file — just enough for context
    // We intentionally don't store full originalFile to avoid bloating the DB
  };
}
```

### Enrichment Logic (pseudocode)

```typescript
// In executor, after Edit tool succeeds:
function enrichEditResult(toolUse, worktreePath) {
  try {
    const filePath = toolUse.input.file_path;
    const oldString = toolUse.input.old_string;
    const newString = toolUse.input.new_string;
    const replaceAll = toolUse.input.replace_all ?? false;

    // Read current file (AFTER edit was applied by the SDK)
    const currentContent = fs.readFileSync(filePath, 'utf-8');

    // Reconstruct pre-edit content by reversing the replacement
    const preEditContent = replaceAll
      ? currentContent.replaceAll(newString, oldString)
      : currentContent.replace(newString, oldString);

    // Compute structured patch using `diff` library
    const patch = structuredPatch(filePath, filePath, preEditContent, currentContent, '', '', { context: 3 });

    return { diff: { structuredPatch: patch.hunks } };
  } catch {
    return {}; // Best effort — return nothing on failure
  }
}
```

**Note:** We reverse-engineer `preEditContent` from `currentContent` since the SDK has already applied the edit by the time we see the result. This is the simplest approach. If `old_string` appears multiple times or the reverse is ambiguous, the diff might be slightly off — that's acceptable for best-effort.

### Files to Modify (executor)

```
packages/executor/src/sdk-handlers/claude/message-processor.ts
  → Add enrichment hook for Edit/Write tool_result events

packages/executor/package.json
  → Add `diff` dependency
```

---

## 4. Library Choice

### `diff` npm package (~7 KB gzipped)

Used in **both** executor (for `structuredPatch`) and UI (for client-side fallback `diffLines`).

Same library Claude Code CLI uses internally. Provides:
- `structuredPatch()` — returns hunks with line numbers (executor)
- `diffLines()` — simple line-level diff (UI fallback)
- `diffWords()` — word-level diff within changed lines (UI highlighting)
- `createPatch()` — unified diff string (for "Copy diff" button)

No new syntax highlighting engine needed — reuse existing `react-syntax-highlighter` with Prism.

---

## 5. Component Interface

### Generic `DiffBlockProps`

```typescript
interface DiffBlockProps {
  /** Absolute file path */
  filePath: string;

  /** Type of file operation */
  operationType: 'edit' | 'create' | 'delete';

  /** Old content — old_string for edit, empty for create */
  oldContent?: string;

  /** New content — new_string for edit, full content for create */
  newContent?: string;

  /** Whether replace_all was used */
  replaceAll?: boolean;

  /** Structured patch from executor enrichment (if available) */
  structuredPatch?: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;

  /** Whether the tool execution resulted in an error */
  isError?: boolean;

  /** Error message if isError */
  errorMessage?: string;

  /** Tool use ID (for React keys) */
  toolUseId: string;
}
```

### Rendering Logic

```typescript
function DiffBlock({ structuredPatch, oldContent, newContent, ... }: DiffBlockProps) {
  if (isError) return <ErrorState />;

  // Tier 1: Rich view from executor enrichment
  if (structuredPatch?.length) {
    return <HunkView hunks={structuredPatch} filePath={filePath} />;
    // Shows: line numbers, context lines, +/- with syntax highlighting
  }

  // Tier 2: Fallback — compute diff client-side from old/new strings
  if (oldContent && newContent) {
    const diff = diffLines(oldContent, newContent);
    return <SimpleDiffView changes={diff} filePath={filePath} />;
    // Shows: +/- lines with syntax highlighting, NO line numbers, NO context
  }

  // Tier 3: Create (all new content)
  if (operationType === 'create' && newContent) {
    return <NewFileView content={newContent} filePath={filePath} />;
    // Shows: all-green with syntax highlighting
  }
}
```

### Mapping from ToolRendererProps

```typescript
// EditRenderer:
const diffProps: DiffBlockProps = {
  filePath: input.file_path as string,
  operationType: 'edit',
  oldContent: input.old_string as string,
  newContent: input.new_string as string,
  replaceAll: input.replace_all as boolean | undefined,
  structuredPatch: result?.diff?.structuredPatch,  // From executor enrichment
  isError: result?.is_error,
  toolUseId,
};

// WriteRenderer:
const diffProps: DiffBlockProps = {
  filePath: input.file_path as string,
  operationType: 'create',
  newContent: input.content as string,
  structuredPatch: result?.diff?.structuredPatch,
  isError: result?.is_error,
  toolUseId,
};
```

---

## 6. UI/UX Design

### Two Rendering Tiers

**Tier 1 — Rich (with structuredPatch from executor):**
```
┌──────────────────────────────────────────────────┐
│ ✏️  src/components/Foo.tsx           +3 -2 lines  │
│ ┌─────────────────────────────────────────────── │
│ │ 146   files?: Record<string, string>;          │
│ │ 147   dependencies?: Record<string, string>;   │
│ │ 148   entry?: string;                          │
│ │ 149 + use_local_bundler?: boolean;             │
│ │ 150   x?: number;                              │
│ │ 151   y?: number;                              │
│ │ ...                                            │
│ └─────────────────────────────────────────────── │
└──────────────────────────────────────────────────┘
```
- Line numbers from `oldStart`/`newStart`
- Context lines (space-prefixed) shown with muted styling
- `...` separators between non-contiguous hunks
- Syntax highlighting matched to file extension

**Tier 2 — Fallback (client-side diffLines only):**
```
┌──────────────────────────────────────────────────┐
│ ✏️  src/components/Foo.tsx           +3 -2 lines  │
│ ┌─────────────────────────────────────────────── │
│ │ - const foo = "old value";                     │
│ │ + const foo = "new value";                     │
│ │ + const bar = "added";                         │
│ └─────────────────────────────────────────────── │
└──────────────────────────────────────────────────┘
```
- No line numbers (don't know file position)
- No context lines (only the changed fragment)
- Still syntax-highlighted and word-level diffed

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default view | **Unified** (not split) | Conversation column too narrow for split |
| Default state | **Collapsed** for >10 diff lines, **expanded** for ≤10 | Small edits visible immediately; large edits don't dominate |
| Syntax highlighting | **Yes**, from file extension | Reuse existing Prism/`ThemedSyntaxHighlighter` |
| Line numbers | **When available** (Tier 1 only) | Meaningful only with full-file context |
| Word-level highlighting | **Yes** (`diffWords` within changed lines) | Shows exactly what changed within a line |
| Color scheme | Green/red backgrounds, semi-transparent | Standard diff colors over syntax highlighting |
| Theme | Ant Design tokens + `isDarkTheme()` | Consistent with app |

### Collapsed State (Default for Large Diffs)

```
┌─────────────────────────────────────────────────┐
│ ✏️  src/components/Foo.tsx          +3 -2 lines  │
└─────────────────────────────────────────────────┘
```

Click to expand. File path shown as relative (strip worktree root).

### Action Buttons

1. **Copy diff** — Unified diff format to clipboard
2. **Collapse/Expand** toggle

### Error State

Red-bordered box with error message (same pattern as `BashRenderer`).

### Large Diff Truncation

For diffs >50 lines: show first 20, "Show N more lines" button. At some point (~500+ lines), show "Large file change — view in Files tab" instead of rendering.

### Multiple Edits to Same File

Each Edit is its own `DiffBlock` — self-contained, rendered in place within the `AgentChain`. No merging. The chain's collapsed summary already shows `Edit × 3, 3 files affected`.

---

## 7. Implementation Plan

### Single Phase: UI + Executor Together

Ship both the UI renderers and executor enrichment in one go. Old messages (before this feature) gracefully fall back to client-side diff.

**Files to create:**
```
apps/agor-ui/src/components/ToolUseRenderer/renderers/
├── EditRenderer.tsx        # Edit tool → DiffBlock mapping
├── WriteRenderer.tsx       # Write tool → DiffBlock (all-additions for new files)
└── DiffBlock/
    ├── DiffBlock.tsx       # Main component (collapsed/expanded, header, actions)
    ├── DiffBlock.css       # Diff line colors, word highlights
    └── useDiff.ts          # Hook: diffLines/diffWords, stats computation
```

**Files to modify:**
```
apps/agor-ui/src/components/ToolUseRenderer/renderers/index.ts
  → Register 'Edit' → EditRenderer, 'Write' → WriteRenderer

apps/agor-ui/package.json
  → pnpm add diff @types/diff

packages/executor/src/sdk-handlers/claude/message-processor.ts
  → Enrich Edit/Write tool_result events with structuredPatch

packages/executor/package.json
  → pnpm add diff @types/diff
```

### Memory Management (Executor Enrichment)

File contents can be large. The enrichment must be aggressive about GC:

```typescript
function enrichEditResult(toolUse) {
  try {
    // Read file — this is the only moment we hold file content in memory
    let fileContent: string | null = fs.readFileSync(filePath, 'utf-8');
    
    // Compute patch immediately — structuredPatch is compact (just hunks)
    const patch = structuredPatch(filePath, filePath, preEdit, fileContent, '', '', { context: 3 });
    
    // Release file content ASAP — only keep the compact hunks
    fileContent = null;
    
    return { diff: { structuredPatch: patch.hunks } };
  } catch {
    return {}; // Best effort
  }
}
```

Rules:
- **Never store `originalFile` in the DB** — only the compact `structuredPatch` hunks
- **Null out file content references** immediately after computing the patch
- **Don't hold file strings across async boundaries** — read, compute, release synchronously
- The resulting hunks are just line strings with +/-/space prefixes — tiny compared to full files
- For very large files (>1MB), skip enrichment entirely — fallback is fine

### Future Enhancements

- Read tool renderer (syntax-highlighted file preview)
- "View file" button → Files tab
- Codex/Gemini edit event mapping
- Split view toggle for modal/expanded view

---

## 8. Bundle Impact

| Addition | Size (gzip) |
|----------|-------------|
| `diff` package | ~7 KB |
| `DiffBlock` component + CSS | ~3 KB |
| `EditRenderer` + `WriteRenderer` | ~1 KB |
| **Total** | **~11 KB** |

---

## 9. Open Questions (Resolved)

1. **`replace_all` indicator** — Show "replaced all occurrences" badge when true. Exact count unknown from input alone but structuredPatch (when available) will show it.

2. **Relative file paths** — Strip worktree root for display. Worktree path available in session context. Fallback: last 3-4 path segments.

3. **Diff algorithm** — `diffLines` for main view, `diffWords` for word-level within changed lines. `diffChars` too noisy.

4. **Streaming** — Show diff immediately from `tool_use.input` (before result arrives). Result only adds success/error status + optional enrichment.

5. **Reverse-engineering pre-edit content** — Acceptable for best-effort. If ambiguous (multiple occurrences, `replace_all`), the structuredPatch may be slightly off. UI still shows something useful; worst case falls back to Tier 2.
