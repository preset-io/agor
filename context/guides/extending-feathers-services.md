# Extending FeathersJS Services

Guide for adding custom methods to FeathersJS services in Agor.

**Official FeathersJS docs**: https://feathersjs.com/api/services

---

## Overview

Agor uses a **hybrid approach** for extending FeathersJS services:

1. **Service methods** - Custom methods registered in the `methods` array (Feathers-idiomatic)
2. **Custom routes** - Separate route handlers for actions that need path parameters (pragmatic)

Both patterns are valid and serve different purposes. Choose based on your use case.

---

## Pattern 1: Service Methods (Preferred for New Features)

**When to use:**
- Methods that operate on the service's primary resource
- Actions that can be called like `client.service('boards').clone(data)`
- No complex path parameters needed

**Example: BoardsService**

File: `apps/agor-daemon/src/services/boards.ts`

### 1. Define the method in your service class

```typescript
export class BoardsService extends DrizzleService<Board, Partial<Board>, BoardParams> {
  /**
   * Clone board (create copy with new ID)
   */
  async clone(
    data: { boardId?: string; id?: string; name?: string; slug?: string } | string,
    newNameOrParams?: string | BoardParams,
    maybeParams?: BoardParams
  ): Promise<Board> {
    // Parse arguments
    const { boardIdentifier, name, params } = this.parseCloneArgs(data, newNameOrParams, maybeParams);

    // Business logic
    const userId = params?.user?.user_id || 'anonymous';
    const resolvedBoardId = await this.resolveBoardId(boardIdentifier);
    const blob = await this.boardRepo.toBlob(resolvedBoardId);
    const boardData = this.buildBoardDataFromBlob(blob, userId, name);

    // ⚠️ CRITICAL: Call repository directly, NOT super.create()
    // Custom methods should create via repository to avoid event emission issues
    const clonedBoard = await this.boardRepo.create(boardData);

    // Note: Events must be emitted by the caller using app.service('boards').emit()
    // this.emit() doesn't work reliably in custom methods due to execution context
    // See index.ts for after hooks that handle event broadcasting

    return clonedBoard;
  }

  /**
   * Import board from blob (JSON)
   */
  async fromBlob(blob: BoardExportBlob, params?: BoardParams): Promise<Board> {
    const userId = params?.user?.user_id || 'anonymous';
    this.boardRepo.validateBoardBlob(blob);
    const data = this.buildBoardDataFromBlob(blob, userId);

    // ⚠️ CRITICAL: Call repository directly, NOT super.create()
    const board = await this.boardRepo.create(data);

    // Note: Events must be emitted by the caller using app.service('boards').emit()
    // this.emit() doesn't work reliably in custom methods due to execution context
    // See index.ts for after hooks that handle event broadcasting

    return board;
  }
}
```

### 2. Register the method in the service configuration

File: `apps/agor-daemon/src/index.ts`

```typescript
app.use('/boards', createBoardsService(db), {
  methods: [
    'find',
    'get',
    'create',
    'update',
    'patch',
    'remove',
    // Custom methods
    'toBlob',
    'fromBlob',
    'toYaml',
    'fromYaml',
    'clone',  // ← Register your custom method here
  ],
});
```

### 3. Add authentication and event emission hooks

```typescript
app.service('boards').hooks({
  before: {
    all: [validateQuery, ...getReadAuthHooks()],
    create: [requireMinimumRole('member', 'create boards')],
    patch: [requireMinimumRole('member', 'update boards')],
    remove: [requireMinimumRole('admin', 'delete boards')],
    // Hooks apply to custom methods too!
    clone: [requireMinimumRole('member', 'clone boards')],
    fromBlob: [requireMinimumRole('member', 'import boards')],
  },
  after: {
    // ⚠️ CRITICAL: Explicitly emit events for WebSocket broadcasting
    // Custom methods that create/update resources need explicit event emission
    clone: [
      async (context: HookContext<Board>) => {
        if (context.result) {
          app.service('boards').emit('created', context.result);
        }
        return context;
      }
    ],
    fromBlob: [
      async (context: HookContext<Board>) => {
        if (context.result) {
          app.service('boards').emit('created', context.result);
        }
        return context;
      }
    ],
  },
});
```

### 4. Client usage

```typescript
// CLI or UI code
const boardsService = client.service('boards');
const clonedBoard = await boardsService.clone({ id: 'board-123', name: 'My Clone' });
```

---

## Pattern 2: Custom Routes (Use When Needed)

**When to use:**
- Actions that need complex path parameters (e.g., `/sessions/:id/prompt`)
- Actions that span multiple resources
- When you need RESTful path structure for external APIs

**Example: Session prompt endpoint**

File: `apps/agor-daemon/src/index.ts`

```typescript
registerAuthenticatedRoute(
  app,
  '/sessions/:id/prompt',
  {
    async create(
      data: { prompt: string; permissionMode?: PermissionMode },
      params: RouteParams
    ) {
      const id = params.route?.id;
      if (!id) throw new Error('Session ID required');

      // Business logic
      const session = await sessionsService.get(id, params);
      // ... execute prompt

      return { success: true, taskId };
    },
  },
  {
    create: { role: 'member', action: 'execute prompts' },
  },
  requireAuth
);
```

**Benefits:**
- RESTful path structure: `POST /sessions/:id/prompt`
- Authentication handled by `registerAuthenticatedRoute` helper
- Clear role-based access control

---

## Critical: Event Broadcasting

### The Problem

**Custom service methods that internally call CRUD operations don't automatically broadcast WebSocket events.**

```typescript
// ❌ BROKEN - Event not published to WebSocket clients
async clone(data, params) {
  return super.create(data, params);  // Event emitted by DrizzleService but not published
}

// ❌ ALSO BROKEN - this.emit() doesn't work reliably in custom methods
async clone(data, params) {
  const result = await super.create(data, params);
  this.emit?.('created', result, params);  // ❌ Doesn't trigger app.publish()
  return result;
}
```

### Why This Happens

FeathersJS event publishing flow:

```
Direct call:    client.service().create()  → hooks → service → emit → app.publish() ✅
Custom method:  client.service().clone()   → hooks → super.create() → emit → ❌ STOPS
Custom method:  client.service().clone()   → this.emit() → ❌ STOPS (no app.publish())
```

**Key insight**: FeathersJS only auto-publishes events from **top-level service method invocations**. Both `super.create()` internal calls and `this.emit()` in custom methods don't trigger the `app.publish()` system.

### The Correct Fix (2-Part Pattern)

#### Part 1: Service Method - Call Repository Directly

```typescript
// ✅ CORRECT - Call repository directly, don't use super.create()
export class BoardsService extends DrizzleService {
  async clone(data, params) {
    // Business logic
    const boardData = this.buildBoardDataFromBlob(blob, userId, name);

    // Call repository directly (NOT super.create)
    const result = await this.boardRepo.create(boardData);

    // Note: Events will be emitted by after hooks in index.ts
    return result;
  }
}
```

#### Part 2: After Hook - Emit with app.service().emit()

```typescript
// ✅ CORRECT - Emit from hooks using app.service().emit()
app.service('boards').hooks({
  before: {
    clone: [requireMinimumRole('member', 'clone boards')],
  },
  after: {
    clone: [
      async (context: HookContext<Board>) => {
        if (context.result) {
          // This DOES trigger app.publish()
          app.service('boards').emit('created', context.result);
        }
        return context;
      }
    ],
  },
});
```

### Why This Pattern Works

1. **Repository call** - Bypasses the double-emit issue from `super.create()`
2. **Hook-based emission** - `app.service().emit()` from hooks DOES trigger `app.publish()`
3. **Execution context** - Hooks have proper context for FeathersJS publishing system

**Event types to emit:**
- `created` - After repository `create()`
- `patched` - After repository `patch()`
- `updated` - After repository `update()`
- `removed` - After repository `remove()`

---

## Authentication Patterns

### Service Methods with Hooks

```typescript
// Define hooks for custom methods
app.service('boards').hooks({
  before: {
    clone: [requireAuth, requireMinimumRole('member', 'clone boards')],
  },
});
```

### Custom Routes with Helper

```typescript
// Use registerAuthenticatedRoute helper (apps/agor-daemon/src/utils/authorization.ts)
registerAuthenticatedRoute(
  app,
  '/sessions/:id/prompt',
  { async create(data, params) { /* ... */ } },
  { create: { role: 'member', action: 'execute prompts' } },
  requireAuth
);
```

---

## Examples: Services That Do It Right

### ✅ BoardsService (Service Methods)

**File**: `apps/agor-daemon/src/services/boards.ts`

**Custom methods:**
- `clone(data, params)` - Clones a board
- `fromBlob(blob, params)` - Imports from JSON
- `fromYaml(yaml, params)` - Imports from YAML
- `toBlob(id)` - Exports to JSON
- `toYaml(id)` - Exports to YAML

**What they do right:**
- ✅ Registered in `methods` array
- ✅ Call repository directly (not `super.create()`)
- ✅ Have `after` hooks in index.ts that emit events via `app.service().emit()`
- ✅ Have authentication hooks (`before` hooks with `requireMinimumRole`)

### ✅ Custom Routes (DRY Pattern)

**File**: `apps/agor-daemon/src/index.ts`

**Examples:**
- `/sessions/:id/fork` - Fork a session
- `/sessions/:id/spawn` - Spawn a child session
- `/sessions/:id/prompt` - Execute a prompt
- `/tasks/:id/complete` - Complete a task

**What they do right:**
- ✅ Use `registerAuthenticatedRoute()` helper
- ✅ No redundant `ensureMinimumRole()` in handlers (hooks handle it)
- ✅ Clear role/action mapping
- ✅ Consistent authentication pattern

---

## Decision Tree: Which Pattern to Use?

```
Does your method operate on the service's primary resource?
├─ YES: Can it be called like client.service('resource').methodName()?
│  ├─ YES: Use Service Method (Pattern 1)
│  │      Example: boardsService.clone()
│  └─ NO: Does it need path parameters like :id?
│         ├─ YES: Use Custom Route (Pattern 2)
│         │      Example: POST /sessions/:id/prompt
│         └─ NO: Use Service Method (Pattern 1)
└─ NO: Does it span multiple resources or need complex routing?
       └─ YES: Use Custom Route (Pattern 2)
              Example: POST /repos/:id/worktrees
```

---

## Common Pitfalls

### ❌ Forgetting to emit events in after hooks

```typescript
// ❌ BAD - No after hook to emit events
async clone(data, params) {
  return this.boardRepo.create(data);  // WebSocket clients won't see this!
}

// ✅ GOOD - Add after hook in index.ts
app.service('boards').hooks({
  after: {
    clone: [
      async (context) => {
        if (context.result) {
          app.service('boards').emit('created', context.result);
        }
        return context;
      }
    ],
  },
});
```

### ❌ Not registering method in methods array

```typescript
// Service has clone() method but it's not callable!
app.use('/boards', createBoardsService(db), {
  methods: ['find', 'get', 'create'],  // Missing 'clone'!
});
```

### ❌ Redundant authorization in handlers

```typescript
// OLD - Authorization happens twice!
async create(data, params) {
  ensureMinimumRole(params, 'member', 'do thing');  // ❌ Redundant
  // ... logic
}

// NEW - Hooks handle it
registerAuthenticatedRoute(
  app, path,
  { async create(data, params) { /* logic */ } },
  { create: { role: 'member', action: 'do thing' } },  // ✅ Once
  requireAuth
);
```

---

## Testing Your Custom Methods

### Unit tests

```typescript
describe('BoardsService.clone', () => {
  it('should clone a board via repository', async () => {
    const cloned = await service.clone({ id: 'board-1', name: 'Clone' });

    expect(cloned.name).toBe('Clone');
    expect(cloned.board_id).toBeDefined();
  });
});
```

### Integration tests

```typescript
describe('POST /boards/:id/clone', () => {
  it('should broadcast created event to WebSocket clients', async () => {
    const client = createTestClient();
    const eventPromise = new Promise(resolve => {
      client.service('boards').on('created', resolve);
    });

    await client.service('boards').clone({ id: 'board-1', name: 'Clone' });

    const event = await eventPromise;
    expect(event.name).toBe('Clone');
  });
});
```

---

## Migration Guide: Custom Routes → Service Methods

If you want to migrate a custom route to a service method:

### 1. Move logic to service class

```typescript
// In apps/agor-daemon/src/services/sessions.ts
export class SessionsService extends DrizzleService {
  async fork(sessionId: string, data: ForkData, params?: SessionParams) {
    // Move route handler logic here
    const result = await this.repository.fork(sessionId, data);
    // Note: Events will be emitted by after hooks in index.ts
    return result;
  }
}
```

### 2. Register in methods array

```typescript
app.use('/sessions', sessionsService, {
  methods: ['find', 'get', 'create', 'patch', 'remove', 'fork'],
});
```

### 3. Add hooks for authentication and event emission

```typescript
app.service('sessions').hooks({
  before: {
    fork: [requireAuth, requireMinimumRole('member', 'fork sessions')],
  },
  after: {
    fork: [
      async (context: HookContext) => {
        if (context.result) {
          app.service('sessions').emit('created', context.result);
        }
        return context;
      }
    ],
  },
});
```

### 4. Update clients

```typescript
// OLD
await client.service('/sessions/:id/fork').create({ prompt });

// NEW
await client.service('sessions').fork(sessionId, { prompt });
```

**Note**: This is a breaking change for external API consumers!

---

## Summary

- **Prefer service methods** for new features when possible (more Feathers-idiomatic)
- **Use custom routes** when you need complex path parameters or RESTful structure
- **Call repository directly** in custom service methods (not `super.create()`)
- **Emit events in after hooks** using `app.service().emit()` (not `this.emit()`)
- **Use helpers** like `registerAuthenticatedRoute()` to reduce boilerplate
- **Test WebSocket broadcasting** to ensure events reach clients

For questions or clarifications, see:
- https://feathersjs.com/api/services
- `apps/agor-daemon/src/services/boards.ts` (service methods example)
- `apps/agor-daemon/src/index.ts` (custom routes examples)
- `apps/agor-daemon/src/utils/authorization.ts` (helper functions)
