# Auth Route Refactoring Guide

## What We've Done

1. ✅ Created `registerAuthenticatedRoute()` helper in `apps/agor-daemon/src/utils/authorization.ts`
2. ✅ Added import in `apps/agor-daemon/src/index.ts`
3. ✅ Refactored 2 example routes: `/sessions/:id/fork` and `/sessions/:id/spawn`

## What Needs to Be Done

Refactor remaining ~28 custom routes to use the helper. Each follows this pattern:

### Before (Old Pattern)
```typescript
app.use('/path/:id/action', {
  async create(data, params) {
    ensureMinimumRole(params, 'member', 'do action');  // ❌ Remove this line
    const id = params.route?.id;
    // ... handler logic
  }
});

app.service('/path/:id/action').hooks({
  before: {
    create: [requireAuth, requireMinimumRole('member', 'do action')],
  },
});
```

### After (New Pattern)
```typescript
registerAuthenticatedRoute(
  app,
  '/path/:id/action',
  {
    async create(data, params) {
      // ❌ Remove ensureMinimumRole call - it's in hooks now
      const id = params.route?.id;
      // ... handler logic
    }
  },
  {
    create: { role: 'member', action: 'do action' }
  },
  requireAuth
);
```

## Routes to Refactor

Search for these patterns in `apps/agor-daemon/src/index.ts`:

1. `/sessions/:id/genealogy` - line ~2037
2. `/sessions/:id/prompt` - line ~2267
3. `/sessions/:id/stop` - line ~2416
4. `/sessions/:id/messages/queue` - line ~2477 (has both create and find)
5. `/sessions/:id/permission-decision` - line ~2643
6. `/sessions/:id/mcp-servers` - line ~2971
7. `/sessions/:id/mcp-servers/:mcpId` - line ~3012
8. `/tasks/bulk` - line ~2708
9. `/tasks/:id/complete` - line ~2715
10. `/tasks/:id/fail` - line ~2727
11. `/repos/local` - line ~2738
12. `/repos/clone` - line ~2744
13. `/repos/:id/worktrees` - line ~2751
14. `/repos/:id/worktrees/:name` - line ~2777
15. `/repos/:id/import-agor-yml` - line ~2788
16. `/repos/:id/export-agor-yml` - line ~2797
17. `/board-comments/:id/toggle-reaction` - line ~2856
18. `/board-comments/:id/reply` - line ~2861
19. `/boards/:id/sessions` - line ~2957
20. `/worktrees/:id/start` - line ~2856
21. `/worktrees/:id/stop` - line ~2866
22. `/worktrees/:id/restart` - line ~2876
23. `/worktrees/:id/health` - line ~2889
24. `/worktrees/:id/archive-or-delete` - line ~2900
25. `/worktrees/:id/unarchive` - line ~2919
26. `/worktrees/logs` - line ~2935
27. `/messages/bulk` - line ~3153

Note: Line numbers are approximate - they shift as you refactor.

## Key Changes

1. **Remove** `ensureMinimumRole(params, ...)` calls from inside route handlers
2. **Keep** business logic (ID extraction, service calls, broadcasting)
3. **Wrap** with `registerAuthenticatedRoute()`
4. **Move** auth config to the authConfig object parameter

## Testing

After refactoring, test:

```bash
# Run the existing integration tests
cd apps/agor-daemon
pnpm test auth-jwt-integration.test.ts

# Start the daemon and verify auth works
pnpm dev

# Try an authenticated request from UI or CLI
```

## Benefits of This Refactor

1. **DRY**: ~180 lines of repetitive hooks → ~30 lines of helper calls
2. **Consistent**: Authentication pattern is uniform across all routes
3. **Maintainable**: Adding new authenticated routes is now trivial
4. **Secure**: Harder to forget authentication on new routes
5. **Feathers-idiomatic**: Hooks applied via proper Feathers API

## Automation Script (Optional)

If you want to automate this, you could use a regex-based script, but be careful with:
- Multi-method routes (like `/messages/queue` with both `create` and `find`)
- Routes with admin vs member roles
- Special cases with complex handlers

Manual refactoring is recommended for safety.
