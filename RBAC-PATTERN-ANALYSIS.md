# RBAC Implications: Service Methods vs Custom Routes

Analysis of Role-Based Access Control differences between FeathersJS service methods and custom routes in Agor.

---

## TL;DR

Both patterns support RBAC equally well, but have different implications for:
- **Granularity**: Custom routes allow per-endpoint permissions, service methods share hooks
- **Flexibility**: Custom routes easier to have different roles per action
- **Discoverability**: Service methods visible via `service.methods`, routes need API docs
- **Internal calls**: Both can bypass auth via `params.provider` check

**Recommendation**: Use custom routes when you need different RBAC rules for different actions on the same resource.

---

## Current RBAC Implementation

### Role Hierarchy

File: `apps/agor-daemon/src/utils/authorization.ts`

```typescript
const ROLE_RANK: Record<Role, number> = {
  viewer: 0,   // Read-only access
  member: 1,   // Standard user (can create/modify their own resources)
  admin: 2,    // System administration
  owner: 3,    // Full system access
};
```

### Authorization Check

```typescript
function ensureMinimumRole(params, minimumRole, action) {
  // Skip authorization for internal calls (daemon-to-daemon)
  if (!params?.provider) {
    return;  // ⚠️ Internal calls bypass RBAC
  }

  if (!params.user) {
    throw new NotAuthenticated('Authentication required');
  }

  if (!hasMinimumRole(params.user.role, minimumRole)) {
    throw new Forbidden(`You need ${minimumRole} access to ${action}`);
  }
}
```

**Key insight**: `params.provider` determines if RBAC is enforced. When calling from code (not HTTP/WebSocket), RBAC is bypassed.

---

## Pattern 1: Service Methods - RBAC Analysis

### Example: BoardsService

```typescript
app.use('/boards', createBoardsService(db), {
  methods: ['find', 'get', 'create', 'patch', 'remove', 'clone', 'fromBlob'],
});

app.service('boards').hooks({
  before: {
    all: [validateQuery, ...getReadAuthHooks()],
    create: [requireMinimumRole('member', 'create boards')],
    patch: [requireMinimumRole('member', 'update boards')],
    remove: [requireMinimumRole('admin', 'delete boards')],
    clone: [requireAuth, requireMinimumRole('member', 'clone boards')],
    fromBlob: [requireAuth, requireMinimumRole('member', 'import boards')],
  },
});
```

### RBAC Characteristics

**✅ Pros:**
1. **Centralized hooks**: All auth logic in one place per service
2. **Method-level granularity**: Each method can have different role requirements
3. **Composable hooks**: Can mix auth with other hooks (validation, etc.)
4. **Automatic application**: Hooks apply to custom methods in `methods` array
5. **Clear visibility**: `service.hooks` shows all RBAC rules for that service

**⚠️ Cons:**
1. **Shared hook context**: All methods share the same hook pipeline structure
2. **Less flexible per-action RBAC**: Harder to have complex role logic for specific methods
3. **Discovery**: Need to look at both `methods` array AND hooks to understand what's protected

**🔒 Security considerations:**
- **Internal bypass**: `params.provider` check allows internal service calls to bypass RBAC
- **Hook ordering**: If hooks are in wrong order, auth might not trigger
- **Method registration**: If method not in `methods` array, it's not accessible (even if it exists)

---

## Pattern 2: Custom Routes - RBAC Analysis

### Example: Session routes

```typescript
registerAuthenticatedRoute(
  app,
  '/sessions/:id/prompt',
  {
    async create(data, params) {
      // Handler logic - no RBAC check needed here
    }
  },
  {
    create: { role: 'member', action: 'execute prompts' }
  },
  requireAuth
);

registerAuthenticatedRoute(
  app,
  '/sessions/:id/stop',
  {
    async create(data, params) {
      // Handler logic
    }
  },
  {
    create: { role: 'admin', action: 'stop sessions' }  // Different role!
  },
  requireAuth
);
```

### RBAC Characteristics

**✅ Pros:**
1. **Per-endpoint granularity**: Each route can have completely different RBAC rules
2. **Explicit role mapping**: Role/action clearly defined at registration
3. **Path-based control**: `/sessions/:id/prompt` vs `/sessions/:id/stop` can have different roles
4. **No shared context**: Routes are independent, no cross-contamination
5. **Easy to audit**: `registerAuthenticatedRoute` calls show all RBAC at a glance

**⚠️ Cons:**
1. **Decentralized**: RBAC rules scattered across route registrations
2. **Harder to see all permissions for a resource**: Need to search for all routes for `/sessions`
3. **Duplication**: If many routes need same role, repeated config

**🔒 Security considerations:**
- **Internal bypass**: Same `params.provider` check as service methods
- **Helper dependency**: Relies on `registerAuthenticatedRoute` being used correctly
- **Manual registration**: Easy to forget authentication if not using helper

---

## Key RBAC Differences

| Aspect | Service Methods | Custom Routes |
|--------|----------------|---------------|
| **Granularity** | Per-method on service | Per-route endpoint |
| **Centralization** | Hooks in one place | Scattered across registrations |
| **Different roles per action** | Supported but verbose | Easy and natural |
| **Path-based RBAC** | Not possible | Natural (e.g., `/:id/admin-action`) |
| **Multi-resource actions** | Awkward | Natural |
| **Visibility** | `service.hooks` | Search for route path |
| **Internal bypass** | `!params.provider` | `!params.provider` |
| **REST API consistency** | Non-standard paths | Standard REST paths |

---

## Advanced RBAC Scenarios

### Scenario 1: Different roles for same operation

**Example**: Regular users can fork their own sessions, admins can fork anyone's

**Service Method Approach:**
```typescript
app.service('sessions').hooks({
  before: {
    fork: [
      requireAuth,
      async (context) => {
        const sessionId = context.id;
        const session = await context.service.get(sessionId);

        // Complex RBAC logic
        if (session.user_id !== context.params.user.user_id) {
          ensureMinimumRole(context.params, 'admin', 'fork other users sessions');
        } else {
          ensureMinimumRole(context.params, 'member', 'fork own sessions');
        }

        return context;
      }
    ]
  }
});
```

**Custom Route Approach:**
```typescript
// Would need TWO routes for this, which is less natural
registerAuthenticatedRoute(
  app,
  '/sessions/:id/fork',
  {
    async create(data, params) {
      const session = await sessionsService.get(id);
      // Check ownership in handler (less clean)
    }
  },
  { create: { role: 'member', action: 'fork sessions' } },
  requireAuth
);
```

**Winner**: Service methods (easier to implement complex RBAC in hooks)

### Scenario 2: Multi-step actions requiring different permissions

**Example**: Starting a worktree requires admin for environment, member for git

**Service Method Approach:**
```typescript
app.service('worktrees').hooks({
  before: {
    start: [
      requireAuth,
      async (context) => {
        // Environment ops require admin
        ensureMinimumRole(context.params, 'admin', 'start environments');

        // Git ops handled separately in method
        return context;
      }
    ]
  }
});
```

**Custom Route Approach:**
```typescript
registerAuthenticatedRoute(
  app,
  '/worktrees/:id/start',
  {
    async create(data, params) {
      // All auth checked in route registration
      // Can't have fine-grained checks mid-execution
    }
  },
  { create: { role: 'admin', action: 'start worktree environments' } },
  requireAuth
);
```

**Winner**: Service methods (can do mid-execution permission checks)

### Scenario 3: Resource-specific permissions

**Example**: User can only modify boards they created

**Service Method Approach:**
```typescript
app.service('boards').hooks({
  before: {
    patch: [
      requireMinimumRole('member', 'update boards'),
      async (context) => {
        const board = await context.service.get(context.id);

        // Resource-specific check
        if (board.created_by !== context.params.user.user_id) {
          ensureMinimumRole(context.params, 'admin', 'update other users boards');
        }

        return context;
      }
    ]
  }
});
```

**Custom Route Approach:**
```typescript
// Same - would need hook or handler logic
registerAuthenticatedRoute(
  app,
  '/boards/:id',
  {
    async patch(id, data, params) {
      const board = await boardsService.get(id);
      // Check in handler (less clean, not DRY)
      if (board.created_by !== params.user.user_id) {
        ensureMinimumRole(params, 'admin', 'update other users boards');
      }
      // ... update logic
    }
  },
  { patch: { role: 'member', action: 'update boards' } },
  requireAuth
);
```

**Winner**: Service methods (hooks are cleaner for resource-based checks)

---

## Internal vs External Call Handling

### The Provider Check

Both patterns support the **same internal bypass mechanism**:

```typescript
if (!params?.provider) {
  return;  // Skip RBAC for internal calls
}
```

**When `params.provider` is set:**
- HTTP requests: `provider = 'rest'`
- WebSocket requests: `provider = 'socketio'`
- Internal calls: `provider = undefined`

**Examples:**

```typescript
// External call (RBAC enforced)
const board = await client.service('boards').clone({ id: 'board-1', name: 'Copy' });
// params.provider = 'socketio' → RBAC checks role

// Internal call (RBAC bypassed)
const board = await boardsService.clone({ id: 'board-1', name: 'Copy' });
// params.provider = undefined → RBAC skipped
```

**Security implication**: Internal services can perform ANY operation, regardless of RBAC. This is intentional for:
- Task executors performing actions on behalf of users
- System maintenance operations
- Inter-service communication

**Risk**: Bugs in internal code could bypass RBAC unintentionally.

---

## Future RBAC Enhancements

### Potential improvements for both patterns:

1. **Attribute-Based Access Control (ABAC)**
   ```typescript
   // Check user attributes beyond role
   if (session.visibility === 'private' && session.user_id !== params.user.user_id) {
     throw new Forbidden('Cannot access private session');
   }
   ```

2. **Resource ownership tracking**
   ```typescript
   // Automatic ownership checks
   app.service('boards').hooks({
     before: {
       patch: [requireOwnershipOr('admin')]
     }
   });
   ```

3. **Permission scopes**
   ```typescript
   // Fine-grained permissions beyond roles
   const permissions = ['boards:read', 'boards:write', 'boards:delete'];
   requirePermission('boards:write');
   ```

4. **Audit logging**
   ```typescript
   // Log all RBAC decisions
   app.service('boards').hooks({
     after: {
       all: [logRBACDecision]
     }
   });
   ```

---

## Recommendations

### Use Service Methods When:
- ✅ You need complex, multi-step RBAC logic
- ✅ Resource-based permissions (ownership, visibility)
- ✅ RBAC rules are similar across methods
- ✅ You want centralized auth configuration
- ✅ Mid-execution permission checks needed

### Use Custom Routes When:
- ✅ Each action needs different roles (e.g., `prompt` = member, `stop` = admin)
- ✅ Path-based RBAC is important (`/sessions/:id/admin-actions`)
- ✅ RESTful API structure is priority
- ✅ Actions span multiple resources
- ✅ Simple, per-endpoint RBAC is sufficient

### Hybrid Approach (Current State):
**Keep both!** They complement each other:
- BoardsService methods for core CRUD + clone/import (similar RBAC rules)
- Session custom routes for varied actions (different RBAC per action)

---

## Security Checklist

Regardless of pattern:

- [ ] Always use `requireAuth` for authenticated endpoints
- [ ] Verify `params.provider` is checked correctly for internal bypasses
- [ ] Test RBAC with different role levels (viewer, member, admin, owner)
- [ ] Audit that all public endpoints have RBAC
- [ ] Document which internal calls bypass RBAC and why
- [ ] Consider logging RBAC failures for security monitoring
- [ ] Test edge cases (ownership, resource visibility, etc.)
- [ ] Review new endpoints in PR for proper RBAC

---

## Summary

**RBAC implications are similar for both patterns**, but differ in:

1. **Granularity**: Service methods = per-method, Custom routes = per-endpoint
2. **Complexity**: Service methods handle complex RBAC better (hooks)
3. **Flexibility**: Custom routes easier for varied role requirements
4. **Organization**: Service methods = centralized, Custom routes = distributed

**The hybrid approach is optimal** because:
- Service methods for resources with consistent RBAC (boards, repos)
- Custom routes for actions with varied RBAC (session operations)

Both patterns:
- Support same role hierarchy
- Use same `ensureMinimumRole()` function
- Bypass RBAC for internal calls via `params.provider`
- Can be audited and tested equally well

**The choice should be based on API design, not RBAC capability** - both are equally secure when used correctly.
