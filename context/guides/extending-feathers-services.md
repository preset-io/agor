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

    // Create via super method
    const clonedBoard = await super.create(
      boardData,
      this.withServerProvider(params)
    ) as Board;

    // ⚠️ CRITICAL: Explicitly emit event for WebSocket subscribers
    // Custom methods don't automatically trigger FeathersJS event publishing
    this.emit?.('created', clonedBoard, params);

    return clonedBoard;
  }

  /**
   * Import board from blob (JSON)
   */
  async fromBlob(blob: BoardExportBlob, params?: BoardParams): Promise<Board> {
    const userId = params?.user?.user_id || 'anonymous';
    this.boardRepo.validateBoardBlob(blob);
    const data = this.buildBoardDataFromBlob(blob, userId);
    const board = await super.create(data, this.withServerProvider(params)) as Board;

    // ⚠️ CRITICAL: Explicitly emit event
    this.emit?.('created', board, params);

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

### 3. Add authentication hooks

```typescript
app.service('boards').hooks({
  before: {
    all: [validateQuery, ...getReadAuthHooks()],
    create: [requireMinimumRole('member', 'create boards')],
    patch: [requireMinimumRole('member', 'update boards')],
    remove: [requireMinimumRole('admin', 'delete boards')],
    // Hooks apply to custom methods too!
    clone: [requireAuth, requireMinimumRole('member', 'clone boards')],
    fromBlob: [requireAuth, requireMinimumRole('member', 'import boards')],
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
// ❌ BROKEN - Event emitted but not published to WebSocket clients
async clone(data, params) {
  return super.create(data, params);  // Event emitted by DrizzleService but not published
}
```

### Why This Happens

FeathersJS event publishing flow:

```
Direct call:    client.service().create()  → hooks → service → emit → app.publish() ✅
Custom method:  client.service().clone()   → hooks → super.create() → emit → ❌ STOPS
```

The `super.create()` DOES emit via `this.emit()`, but FeathersJS only auto-publishes events from **top-level service method invocations**, not internal super calls.

### The Fix

**Always explicitly emit events after calling super methods:**

```typescript
// ✅ CORRECT - Explicitly emit for WebSocket broadcasting
async clone(data, params) {
  const result = await super.create(data, params);

  // Explicitly emit event for WebSocket subscribers
  // Custom methods don't automatically trigger FeathersJS event publishing
  this.emit?.('created', result, params);

  return result;
}
```

**Event types to emit:**
- `created` - After `super.create()`
- `patched` - After `super.patch()`
- `updated` - After `super.update()`
- `removed` - After `super.remove()`

### Alternative: Direct Repository Access

```typescript
async customMethod(data, params) {
  // Skip super, call repository directly
  const result = await this.repository.create(data);

  // Emit event for WebSocket broadcasting
  this.emit?.('created', result, params);

  return result;
}
```

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
- ✅ Call `super.create()` for CRUD operations
- ✅ Explicitly emit events after super calls
- ✅ Use `this.withServerProvider(params)` to ensure provider is set
- ✅ Have authentication hooks

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

### ❌ Forgetting to emit events

```typescript
async clone(data, params) {
  return super.create(data, params);  // WebSocket clients won't see this!
}
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
  it('should clone a board and emit created event', async () => {
    const emitSpy = jest.fn();
    service.emit = emitSpy;

    const cloned = await service.clone({ id: 'board-1', name: 'Clone' });

    expect(emitSpy).toHaveBeenCalledWith('created', cloned, expect.any(Object));
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
    this.emit?.('created', result, params);
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

### 3. Add hooks

```typescript
app.service('sessions').hooks({
  before: {
    fork: [requireAuth, requireMinimumRole('member', 'fork sessions')],
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
- **Always emit events** after calling super methods in custom service methods
- **Use helpers** like `registerAuthenticatedRoute()` to reduce boilerplate
- **Test WebSocket broadcasting** to ensure events reach clients

For questions or clarifications, see:
- https://feathersjs.com/api/services
- `apps/agor-daemon/src/services/boards.ts` (service methods example)
- `apps/agor-daemon/src/index.ts` (custom routes examples)
- `apps/agor-daemon/src/utils/authorization.ts` (helper functions)
