# Analytics

**Status:** Ready to implement
**Last Updated:** January 2025
**Related:** [[architecture]], [[models]]

---

## Overview

Lightweight analytics logging using Segment to track usage and costs. Captures all database operations via FeathersJS app-level hooks with minimal overhead.

**Core insight:** Task completions already contain token usage and cost data - we just need to pipe it to Segment!

### What Gets Tracked

✅ **All database operations** via FeathersJS service calls:

- Session lifecycle (create, status changes)
- **Task completions with token/cost data** ⭐
- Worktree operations
- User actions
- MCP server configuration

❌ **Filtered out** (too chatty):

- Health checks
- Terminal events (very high volume)
- List operations (`.find()` calls)
- Context file browsing

---

## Architecture

```
FeathersJS Service Method
        ↓
app.hooks({ after: { all: [...] } })  ◄── Single hook captures ALL services
        ↓
AnalyticsService.track()
        ↓
Apply denylist filter
        ↓
SegmentProcessor.track()  ◄── Batches 15 events, flushes every 10s
        ↓
Segment → Warehouse
```

### Key Components

**1. AnalyticsService** (`apps/agor-daemon/src/services/analytics.ts`)

- Registers app-level FeathersJS hook
- Builds events from service context
- Applies denylist filtering
- Routes to processor

**2. SegmentProcessor** (`apps/agor-daemon/src/analytics/segment-processor.ts`)

- Wraps `@segment/analytics-node`
- Batches events (15 per batch, 10s interval)
- Non-blocking (internal queue)

**3. Event Filtering** (`apps/agor-daemon/src/analytics/filters.ts`)

- Regex-based denylist/allowlist
- Filters noisy events (health checks, terminals, find operations)

---

## Event Schema

Every event is a simple JSON blob:

```typescript
interface AnalyticsEvent {
  event: string; // "sessions.create", "tasks.patch", etc.
  timestamp: string; // ISO 8601
  userId: string; // User ID or "anonymous"

  properties: {
    service: string; // Service name
    method: string; // CRUD method

    // Entity IDs (for warehouse joins)
    sessionId?: string;
    taskId?: string;
    worktreeId?: string;
    boardId?: string;
    repoId?: string;

    // Context (minimal, avoid denormalization)
    status?: string;
    agenticTool?: string;

    // Usage data (from task completions!)
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens?: number;
      cache_creation_tokens?: number;
      estimated_cost_usd: number;
    };
  };
}
```

### Example: Task Completion Event

This is the money event - contains all the token/cost data:

```json
{
  "event": "tasks.patch",
  "timestamp": "2025-01-11T10:35:12.456Z",
  "userId": "019a1b2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "properties": {
    "service": "tasks",
    "method": "patch",
    "taskId": "019a3b4c-...",
    "sessionId": "019a1b2c-...",
    "worktreeId": "019a5b6c-...",
    "status": "completed",
    "agenticTool": "claude-code",
    "usage": {
      "input_tokens": 12500,
      "output_tokens": 3200,
      "cache_read_tokens": 8000,
      "estimated_cost_usd": 0.0234
    }
  }
}
```

Now you can query in your warehouse: total tokens by user, by worktree, by agent, by day, etc.

---

## Implementation

### File Structure

```
apps/agor-daemon/src/
├── services/
│   └── analytics.ts          # AnalyticsService (registers hooks)
│
└── analytics/
    ├── processor.ts           # AnalyticsEventProcessor interface
    ├── segment-processor.ts   # Segment implementation
    └── filters.ts             # Blacklist configuration
```

### 1. AnalyticsEventProcessor Interface

**File:** `apps/agor-daemon/src/analytics/processor.ts`

```typescript
export interface AnalyticsEvent {
  event: string;
  timestamp: string;
  userId: string;
  properties: Record<string, unknown>;
}

export interface AnalyticsEventProcessor {
  track(event: AnalyticsEvent): Promise<void>;
  flush(): Promise<void>;
}

/**
 * No-op processor (default when SEGMENT_WRITE_KEY not set)
 */
export class NoOpProcessor implements AnalyticsEventProcessor {
  async track(_event: AnalyticsEvent): Promise<void> {
    // Do nothing
  }

  async flush(): Promise<void> {
    // Do nothing
  }
}
```

### 2. SegmentProcessor

**File:** `apps/agor-daemon/src/analytics/segment-processor.ts`

**Install:** `pnpm add @segment/analytics-node`

```typescript
import { Analytics } from '@segment/analytics-node';
import type { AnalyticsEvent, AnalyticsEventProcessor } from './processor';

export class SegmentProcessor implements AnalyticsEventProcessor {
  private analytics: Analytics;

  constructor(writeKey: string) {
    this.analytics = new Analytics({
      writeKey,
      maxEventsInBatch: 15,
      flushInterval: 10000, // 10 seconds
    });
  }

  async track(event: AnalyticsEvent): Promise<void> {
    // Non-blocking, queued internally
    this.analytics.track({
      userId: event.userId,
      event: event.event,
      timestamp: new Date(event.timestamp),
      properties: event.properties,
    });
  }

  async flush(): Promise<void> {
    await this.analytics.flush();
  }
}
```

### 3. Event Filtering

**File:** `apps/agor-daemon/src/analytics/filters.ts`

```typescript
export type FilterMode = 'passthrough' | 'denylist' | 'allowlist';

export interface EventFilter {
  mode: FilterMode;
  patterns: string[]; // Regex patterns
}

/**
 * Production denylist - filters noisy events
 */
export const PRODUCTION_DENYLIST: EventFilter = {
  mode: 'denylist',
  patterns: [
    '^health-monitor\\.', // Health checks
    '^terminals\\.', // Terminal events (very chatty)
    '\\.find$', // List operations (can be noisy)
    '^context\\.', // Context file browsing
  ],
};

/**
 * Check if event should be filtered
 */
export function shouldFilterEvent(eventName: string, filter: EventFilter): boolean {
  if (filter.mode === 'passthrough') {
    return false; // No filtering
  }

  const matches = filter.patterns.some(pattern => new RegExp(pattern).test(eventName));

  if (filter.mode === 'denylist') {
    return matches; // Filter if matches
  }

  if (filter.mode === 'allowlist') {
    return !matches; // Filter if doesn't match
  }

  return false;
}
```

### 4. AnalyticsService

**File:** `apps/agor-daemon/src/services/analytics.ts`

```typescript
import type { Application, HookContext } from '@feathersjs/feathers';
import type { AnalyticsEventProcessor, AnalyticsEvent } from '../analytics/processor';
import type { EventFilter } from '../analytics/filters';
import { shouldFilterEvent } from '../analytics/filters';

export class AnalyticsService {
  private processor: AnalyticsEventProcessor;
  private filter: EventFilter;

  constructor(processor: AnalyticsEventProcessor, filter: EventFilter) {
    this.processor = processor;
    this.filter = filter;
  }

  /**
   * Track a custom event (for manual instrumentation)
   */
  async track(event: AnalyticsEvent): Promise<void> {
    if (shouldFilterEvent(event.event, this.filter)) {
      return; // Filtered out
    }

    await this.processor.track(event);
  }

  /**
   * Register app-level hooks for passive capture
   */
  registerHooks(app: Application): void {
    app.hooks({
      after: {
        all: [this.createTrackingHook()],
      },
    });
  }

  /**
   * Create FeathersJS hook for passive event tracking
   */
  private createTrackingHook() {
    return async (context: HookContext) => {
      try {
        const event = this.buildEventFromContext(context);

        // Track asynchronously (don't block response)
        this.track(event).catch(err => {
          console.error('Analytics tracking error:', err);
        });
      } catch (err) {
        // Never throw from analytics hook (fail silently)
        console.error('Analytics hook error:', err);
      }

      return context;
    };
  }

  /**
   * Build analytics event from FeathersJS context
   */
  private buildEventFromContext(context: HookContext): AnalyticsEvent {
    const { method, path, result, params } = context;

    return {
      event: `${path}.${method}`,
      timestamp: new Date().toISOString(),
      userId: params.user?.user_id || 'anonymous',
      properties: {
        service: path,
        method: method,

        // Extract entity IDs from result
        ...(result?.session_id && { sessionId: result.session_id }),
        ...(result?.task_id && { taskId: result.task_id }),
        ...(result?.worktree_id && { worktreeId: result.worktree_id }),
        ...(result?.board_id && { boardId: result.board_id }),
        ...(result?.repo_id && { repoId: result.repo_id }),
        ...(result?.user_id && { affectedUserId: result.user_id }),

        // Status/agent context
        ...(result?.status && { status: result.status }),
        ...(result?.agentic_tool && { agenticTool: result.agentic_tool }),

        // Usage data (from tasks!)
        ...(result?.data?.usage && { usage: result.data.usage }),
      },
    };
  }

  /**
   * Flush pending events (call on shutdown)
   */
  async flush(): Promise<void> {
    await this.processor.flush();
  }
}
```

### 5. Wire It Up in Daemon

**File:** `apps/agor-daemon/src/index.ts`

```typescript
import { loadConfig } from '@agor/core/config';
import { AnalyticsService } from './services/analytics';
import { SegmentProcessor } from './analytics/segment-processor';
import { NoOpProcessor } from './analytics/processor';
import { PRODUCTION_DENYLIST, type EventFilter } from './analytics/filters';

// Load analytics config
const config = await loadConfig();
const analyticsConfig = config.analytics || {};

// Determine write key (env var takes precedence)
const writeKey = process.env.SEGMENT_WRITE_KEY || analyticsConfig.segmentWriteKey;

// Check if analytics is explicitly disabled
const isEnabled = analyticsConfig.enabled !== false;

// Initialize processor
const analyticsProcessor =
  isEnabled && writeKey ? new SegmentProcessor(writeKey) : new NoOpProcessor();

// Build filter from config or use defaults
const filter: EventFilter = {
  mode: analyticsConfig.filterMode || 'denylist',
  patterns: analyticsConfig.filterPatterns || PRODUCTION_DENYLIST.patterns,
};

const analyticsService = new AnalyticsService(analyticsProcessor, filter);

// Register app-level hooks
analyticsService.registerHooks(app);

// Graceful shutdown - flush events
process.on('SIGTERM', async () => {
  console.log('Flushing analytics events...');
  await analyticsService.flush();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Flushing analytics events...');
  await analyticsService.flush();
  process.exit(0);
});
```

---

## Configuration

Analytics configuration is managed through Agor's standard config system (`~/.agor/config.yaml`).

### Config File

```yaml
# ~/.agor/config.yaml
analytics:
  enabled: true # Master switch (default: true if segmentWriteKey or SEGMENT_WRITE_KEY set)
  segmentWriteKey: sk_... # Can also use SEGMENT_WRITE_KEY env var

  filterMode: denylist # passthrough, denylist, allowlist
  filterPatterns: # Regex patterns (default: production denylist)
    - "^health-monitor\\."
    - "^terminals\\."
    - "\\.find$"
    - "^context\\."
```

### CLI Commands

```bash
# Set Segment write key
agor config set analytics.segmentWriteKey sk_...

# Or use environment variable (precedence: env var > config file)
export SEGMENT_WRITE_KEY=sk_...

# Disable analytics
agor config set analytics.enabled false

# View analytics config
agor config get analytics

# Change filter mode
agor config set analytics.filterMode allowlist

# Add custom filter pattern
agor config set analytics.filterPatterns[0] "^my-noisy-service\\."
```

### Precedence Rules

**Write key:**

1. `SEGMENT_WRITE_KEY` environment variable (highest priority)
2. `analytics.segmentWriteKey` in config file
3. If neither set → `NoOpProcessor` (zero overhead)

**Filter mode/patterns:**

1. Config file (`analytics.filterMode`, `analytics.filterPatterns`)
2. If not set → production denylist (hardcoded defaults)

### Segment Setup

1. Create Segment workspace at https://segment.com
2. Create a new Source → Node.js
3. Copy the Write Key
4. Set via config: `agor config set analytics.segmentWriteKey sk_...`
5. Start daemon
6. Check Segment Debugger to see events

---

## High-Value Events

These are the events you'll care about most:

| Event                            | What it captures                         | Key properties                                                           |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| `tasks.patch` (status=completed) | ⭐ **Task completion with tokens/costs** | `usage.{input_tokens, output_tokens, estimated_cost_usd}`, `agenticTool` |
| `sessions.create`                | New session started                      | `agenticTool`, `worktreeId`, `boardId`                                   |
| `sessions.patch`                 | Session status change                    | `status`, `sessionId`                                                    |
| `worktrees.create`               | New worktree created                     | `worktreeId`, `repoId`                                                   |
| `users.create`                   | New user registered                      | `userId`                                                                 |

### Filtered Out (denylisted)

- `health-monitor.*` - Health checks (every 30s)
- `terminals.*` - Terminal output events (very high volume)
- `*.find` - List operations (can be noisy)
- `context.*` - Context file browsing

---

## Warehouse Queries

Once events flow into your warehouse, you can query:

### Total Tokens by User (Last 30 Days)

```sql
SELECT
  properties.userId,
  SUM(CAST(properties.usage.input_tokens AS INT64)) as total_input_tokens,
  SUM(CAST(properties.usage.output_tokens AS INT64)) as total_output_tokens,
  SUM(CAST(properties.usage.estimated_cost_usd AS FLOAT64)) as total_cost_usd
FROM analytics_events
WHERE event = 'tasks.patch'
  AND properties.status = 'completed'
  AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY properties.userId
ORDER BY total_cost_usd DESC;
```

### Agent Usage Breakdown

```sql
SELECT
  properties.agenticTool as agent,
  COUNT(*) as task_count,
  SUM(CAST(properties.usage.estimated_cost_usd AS FLOAT64)) as total_cost_usd
FROM analytics_events
WHERE event = 'tasks.patch'
  AND properties.status = 'completed'
  AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY agent
ORDER BY total_cost_usd DESC;
```

### Daily Active Users

```sql
SELECT
  DATE(timestamp) as date,
  COUNT(DISTINCT userId) as dau
FROM analytics_events
WHERE event LIKE 'sessions.%'
  AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY date
ORDER BY date DESC;
```

---

## Testing

### Manual Testing with Segment Debugger

1. Set `SEGMENT_WRITE_KEY` in `.env`
2. Start daemon: `cd apps/agor-daemon && pnpm dev`
3. Perform actions:

   ```bash
   # Create a session
   agor session start --agent claude-code

   # Submit a task (will generate tasks.patch event with usage!)
   # ... agent completes task ...
   ```

4. Check Segment Debugger: https://app.segment.com/[workspace]/sources/[source]/debugger
5. Verify events appear with correct properties

### Local Testing (No-op Mode)

```bash
# No SEGMENT_WRITE_KEY or config → uses NoOpProcessor
unset SEGMENT_WRITE_KEY
cd apps/agor-daemon && pnpm dev

# Analytics hooks run but do nothing (zero overhead)

# Or explicitly disable via config
agor config set analytics.enabled false
```

### Denylist Testing

Add a console.log to see filtered events:

```typescript
// In AnalyticsService.track()
if (shouldFilterEvent(event.event, this.filter)) {
  console.log('[Analytics] Filtered:', event.event);
  return;
}
```

### Test Different Filter Modes

```bash
# Test allowlist mode (only track sessions and tasks)
agor config set analytics.filterMode allowlist
agor config set analytics.filterPatterns[0] "^sessions\\."
agor config set analytics.filterPatterns[1] "^tasks\\."

# Test passthrough (no filtering)
agor config set analytics.filterMode passthrough

# Back to denylist
agor config set analytics.filterMode denylist
```

---

## Performance

**Overhead per request:**

- Hook execution: ~0.1ms (building event object)
- Segment track(): ~0.01ms (non-blocking queue)
- **Total: <0.2ms** ✅

**Batching:**

- Segment batches up to 15 events
- Flushes every 10 seconds
- Async (doesn't block responses)

**Expected volume:**

- ~100-500 events/day for single user
- ~10-50k events/day for team of 20
- Well within Segment free tier (1k MTUs = ~1k events)

---

## Next Steps

1. [ ] Create `apps/agor-daemon/src/analytics/` directory
2. [ ] Implement `processor.ts`, `segment-processor.ts`, `filters.ts`
3. [ ] Implement `services/analytics.ts`
4. [ ] Wire up in `index.ts`
5. [ ] Install `@segment/analytics-node`
6. [ ] Set `SEGMENT_WRITE_KEY` in `.env`
7. [ ] Test with Segment debugger
8. [ ] Verify task completion events include usage data

**Estimated time: 2-3 hours** ⏱️

---

## Notes

- ✅ **Fail silently** - Analytics errors never affect user requests
- ✅ **Non-blocking** - Events queued, don't slow down responses
- ✅ **Privacy-friendly** - No prompt content, just IDs and metadata
- ✅ **Warehouse-first** - Minimal denormalization, enrich in warehouse
- ✅ **Already have the data** - Task usage is already in the DB, just pipe it to Segment!

---

**End of Document**
