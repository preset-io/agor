# Materialize Normalized SDK Payload

**Status:** Exploration
**Related:** [[agent-accounting]], [[creating-database-migrations]]

---

## Problem Statement

Token/cost accounting is broken in the UI. The issue is that:

1. `Task.normalized_sdk_response` field exists in the TypeScript type
2. Normalizers exist for each SDK (Claude, Codex, Gemini)
3. **BUT** the field is never populated or stored in the database
4. UI reads from `task.normalized_sdk_response` and always gets `undefined`

Currently, the leaderboard service works around this by doing expensive JSON extraction queries directly on `raw_sdk_response`:

```typescript
// apps/agor-daemon/src/services/leaderboard.ts:154-163
CAST(${jsonExtract(this.db, tasks.data, 'raw_sdk_response.tokenUsage.input_tokens')} AS INTEGER)
```

This is inefficient and requires SDK-specific knowledge in the query layer.

---

## Current State Analysis

### What Exists

| Component                                | Status         | Location                                                          |
| ---------------------------------------- | -------------- | ----------------------------------------------------------------- |
| Task type with `normalized_sdk_response` | ✅ Defined     | `packages/core/src/types/task.ts:70-80`                           |
| `ClaudeCodeNormalizer`                   | ✅ Implemented | `packages/executor/src/sdk-handlers/claude/normalizer.ts`         |
| `CodexNormalizer`                        | ✅ Implemented | `packages/executor/src/sdk-handlers/codex/normalizer.ts`          |
| `GeminiNormalizer`                       | ✅ Implemented | `packages/executor/src/sdk-handlers/gemini/normalizer.ts`         |
| `INormalizer` interface                  | ✅ Defined     | `packages/executor/src/sdk-handlers/base/normalizer.interface.ts` |
| Database schema column                   | ❌ Missing     | `packages/core/src/db/schema.sqlite.ts`                           |
| Repository storage                       | ❌ Missing     | `packages/core/src/db/repositories/tasks.ts`                      |
| Executor calling normalizers             | ❌ Missing     | `packages/executor/src/handlers/sdk/base-executor.ts`             |

### Data Flow (Current - Broken)

```
SDK Event (e.g., turn.completed)
  ↓
Tool extracts rawSdkResponse
  ↓
Task patched with raw_sdk_response (stored in DB)
  ↓
UI reads task.normalized_sdk_response → undefined (NOT STORED!)
  ↓
Token pills show nothing
```

### Data Flow (Desired)

```
SDK Event (e.g., turn.completed)
  ↓
Tool extracts rawSdkResponse
  ↓
Normalizer transforms raw → normalized format
  ↓
Task patched with BOTH:
  - raw_sdk_response (for debugging)
  - normalized_sdk_response (for UI/analytics)
  ↓
UI reads task.normalized_sdk_response → shows tokens/cost
```

---

## Type Definitions

### Task.normalized_sdk_response (Already Defined)

```typescript
// packages/core/src/types/task.ts:70-80
normalized_sdk_response?: {
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;    // Claude-specific
    cacheCreationTokens?: number; // Claude-specific
  };
  contextWindowLimit?: number;  // Model's max context window
  costUsd?: number;             // Estimated cost in USD
};
```

### NormalizedSdkData (Normalizer Output)

```typescript
// packages/executor/src/sdk-handlers/base/normalizer.interface.ts
export interface NormalizedSdkData {
  tokenUsage: NormalizedTokenUsage;
  contextWindowLimit: number;
  costUsd?: number;
  primaryModel?: string;
  durationMs?: number;
}

export interface NormalizedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
```

**Note:** The normalizer output matches the Task type exactly - no mapping needed.

---

## Implementation Plan

### Step 1: Add Column to Database Schema

**Files to modify:**

- `packages/core/src/db/schema.sqlite.ts`
- `packages/core/src/db/schema.postgres.ts`

```typescript
// In tasks table data JSON column:
data: t.json<unknown>('data').$type<{
  // ... existing fields ...

  // Raw SDK response - single source of truth for token accounting
  raw_sdk_response?: Task['raw_sdk_response'];

  // NEW: Normalized SDK response - computed by executor at task completion
  normalized_sdk_response?: Task['normalized_sdk_response'];

  // ... rest of fields ...
}>();
```

**Migration:** Not strictly required since it's inside the JSON column, but the TypeScript type needs updating.

### Step 2: Update Repository to Store Normalized Response

**File:** `packages/core/src/db/repositories/tasks.ts`

```typescript
// In taskToInsert():
private taskToInsert(task: Partial<Task>): TaskInsert {
  return {
    // ... existing fields ...
    data: {
      // ... existing data fields ...
      raw_sdk_response: task.raw_sdk_response,
      normalized_sdk_response: task.normalized_sdk_response, // NEW
      // ...
    },
  };
}

// In rowToTask():
private rowToTask(row: TaskRow): Task {
  return {
    task_id: row.task_id as UUID,
    session_id: row.session_id as UUID,
    // ... spreads row.data which now includes normalized_sdk_response ...
    ...row.data,
  };
}
```

### Step 3: Call Normalizers in Executor

**File:** `packages/executor/src/handlers/sdk/base-executor.ts`

The challenge: `base-executor.ts` doesn't know which SDK is being used. Options:

#### Option A: Normalizer Factory (Recommended)

Create a factory that selects the right normalizer based on agentic tool:

```typescript
// packages/executor/src/sdk-handlers/normalizer-factory.ts
import { ClaudeCodeNormalizer } from './claude/normalizer.js';
import { CodexNormalizer } from './codex/normalizer.js';
import { GeminiNormalizer } from './gemini/normalizer.js';
import type { NormalizedSdkData } from './base/normalizer.interface.js';

export function normalizeRawSdkResponse(
  agenticTool: 'claude-code' | 'codex' | 'gemini' | 'opencode',
  rawSdkResponse: unknown
): NormalizedSdkData | undefined {
  if (!rawSdkResponse) return undefined;

  switch (agenticTool) {
    case 'claude-code':
      return new ClaudeCodeNormalizer().normalize(rawSdkResponse);
    case 'codex':
      return new CodexNormalizer().normalize(rawSdkResponse);
    case 'gemini':
      return new GeminiNormalizer().normalize(rawSdkResponse);
    case 'opencode':
      return undefined; // TODO: Implement OpenCodeNormalizer
    default:
      console.warn(`Unknown agentic tool: ${agenticTool}`);
      return undefined;
  }
}
```

#### Option B: Per-Tool Executor Patching

Each tool (Claude, Codex, Gemini) already returns `rawSdkResponse`. Add normalization inline:

```typescript
// In each *-tool.ts executePromptWithStreaming():
import { ClaudeCodeNormalizer } from './normalizer.js';

// After getting rawSdkResponse:
const normalizer = new ClaudeCodeNormalizer();
const normalized = rawSdkResponse ? normalizer.normalize(rawSdkResponse) : undefined;

return {
  // ... existing fields ...
  rawSdkResponse,
  normalizedSdkResponse: normalized, // NEW
};
```

Then update the executor result handling to include it in the task patch.

### Step 4: Patch Task with Normalized Response

**File:** Where tasks are completed - likely in the tool or executor.

Current code stores `raw_sdk_response` somewhere (need to trace). Add `normalized_sdk_response` alongside it.

```typescript
// When completing task:
await client.service('tasks').patch(taskId, {
  status: 'completed',
  raw_sdk_response: result.rawSdkResponse,
  normalized_sdk_response: result.normalizedSdkResponse, // NEW
});
```

### Step 5: UI Already Works!

The UI is already coded to use `task.normalized_sdk_response`:

```typescript
// apps/agor-ui/src/components/TaskBlock/TaskBlock.tsx:395
const normalized = task.normalized_sdk_response || null;

// apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx:195-197
if (!task.normalized_sdk_response) return acc;
const { tokenUsage, costUsd } = task.normalized_sdk_response;
```

Once we populate the field, the UI will "just work."

---

## Where is raw_sdk_response Actually Saved?

Based on code analysis, `raw_sdk_response` flows through:

1. **Tool captures it:** e.g., `claude-tool.ts:439` - `rawSdkResponse = event.raw_sdk_message`
2. **Tool returns it:** e.g., `claude-tool.ts:599` - `return { ..., rawSdkResponse }`
3. **Executor receives it:** Via `tool.executePromptWithStreaming()` result
4. **??? Where is it patched to DB ???**

**Finding the gap:** Need to trace where `rawSdkResponse` from tool result gets saved to task.

Looking at `base-executor.ts:333`:

```typescript
await client.service('tasks').patch(taskId, patchData);
```

The `patchData` only includes `status`, `completed_at`, and `git_state`. It does NOT include `raw_sdk_response`!

**This is the bug location.** The `raw_sdk_response` is being captured by tools but never patched to the task.

Wait - let me check the leaderboard query again:

```typescript
jsonExtract(this.db, tasks.data, 'raw_sdk_response.tokenUsage.input_tokens');
```

This implies `raw_sdk_response` IS in the database somehow. Let me check if there's another patch location...

Actually, looking more carefully at the leaderboard query structure - it's querying `raw_sdk_response.tokenUsage.X` which suggests the data IS stored but in a specific format that includes a `tokenUsage` wrapper.

**Key Insight:** The leaderboard is querying a path that includes `tokenUsage` as a key inside `raw_sdk_response`. This means either:

1. Some tools store a pre-normalized format with `tokenUsage` key, OR
2. The raw SDK responses naturally have a `tokenUsage` field

Looking at Codex/Gemini tools, they DO add `tokenUsage` to the raw response before storing.

---

## Revised Analysis

The issue may be more nuanced:

1. `raw_sdk_response` IS being stored (leaderboard queries work)
2. `normalized_sdk_response` is NOT being stored (UI broken)
3. The fix is specifically to call normalizers and store the result

**Action Items:**

1. Trace exactly where `raw_sdk_response` gets patched to tasks
2. Add normalizer call at that location
3. Store result as `normalized_sdk_response`
4. Add field to schema/repository

---

## Migration Not Required (Probably)

Since `normalized_sdk_response` is inside the JSON `data` column:

- SQLite: JSON is stored as TEXT, any shape works
- Postgres: JSONB accepts any shape

The schema TypeScript type needs updating for type safety, but no SQL migration is needed. The repository just needs to read/write the new field.

---

## Testing Plan

1. **Unit tests:** Normalizer tests already exist (e.g., `codex/normalizer.test.ts`)
2. **Integration test:** Create task, verify `normalized_sdk_response` populated
3. **UI test:** Verify token pills display after fix

---

## Related Files

**Types:**

- `packages/core/src/types/task.ts` - Task type definition

**Normalizers:**

- `packages/executor/src/sdk-handlers/base/normalizer.interface.ts` - Interface
- `packages/executor/src/sdk-handlers/claude/normalizer.ts` - Claude
- `packages/executor/src/sdk-handlers/codex/normalizer.ts` - Codex
- `packages/executor/src/sdk-handlers/gemini/normalizer.ts` - Gemini

**Schema:**

- `packages/core/src/db/schema.sqlite.ts` - SQLite schema
- `packages/core/src/db/schema.postgres.ts` - Postgres schema

**Repository:**

- `packages/core/src/db/repositories/tasks.ts` - Task CRUD

**Executor:**

- `packages/executor/src/handlers/sdk/base-executor.ts` - Task completion

**UI (already ready):**

- `apps/agor-ui/src/components/TaskBlock/TaskBlock.tsx`
- `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx`
- `apps/agor-ui/src/components/Pill/Pill.tsx`

---

## Summary

**Status: ✅ IMPLEMENTED**

The accounting feature is now complete:

- ✅ Types defined (`packages/core/src/types/task.ts`)
- ✅ Normalizers implemented (Claude, Codex, Gemini)
- ✅ UI coded (TaskBlock, SessionPanel, Pill)
- ✅ Schema updated (SQLite + Postgres)
- ✅ Repository stores `normalized_sdk_response`
- ✅ Normalizer factory created (`packages/executor/src/sdk-handlers/normalizer-factory.ts`)
- ✅ Base executor calls normalizer and patches task with both raw and normalized responses

**Implementation Details:**

1. **Schema** (`schema.sqlite.ts`, `schema.postgres.ts`): Added `normalized_sdk_response` to tasks data JSON
2. **Repository** (`tasks.ts`): Now stores `normalized_sdk_response` alongside `raw_sdk_response`
3. **Normalizer Factory** (`normalizer-factory.ts`): Dispatches to correct normalizer by agentic tool type
4. **Base Executor** (`base-executor.ts`):
   - Updated `BaseTool` interface to include `rawSdkResponse` in return type
   - Calls `normalizeRawSdkResponse(toolName, result.rawSdkResponse)` at task completion
   - Patches task with both `raw_sdk_response` and `normalized_sdk_response`

**Testing:** Run a task and verify token/cost pills appear in the UI.

---

_Created: 2025-12-03_
_Implemented: 2025-12-03_
