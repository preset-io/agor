# Executor Authentication Fix - JWT Migration

## The Problem

Executor authentication was failing with "jwt malformed" errors despite successful initial authentication. The root cause was that we were using **opaque UUID session tokens** with a **custom Feathers authentication strategy**.

### Why This Failed

Feathers authentication has JWT-specific logic baked into its core:

1. It expects `accessToken` to be a JWT that can be decoded
2. Custom strategies have issues with socket authentication persistence
3. Even with manual socket storage, the authentication wasn't persisting to subsequent requests

## The Solution

**Stop fighting Feathers - use JWTs for session tokens!**

Instead of custom UUIDs, session tokens are now **standard JWTs** containing:

```json
{
  "sub": "user_id",
  "sessionId": "session_id",
  "iat": 1234567890,
  "exp": 1234567890
}
```

### What Changed

1. **SessionTokenService** (apps/agor-daemon/src/services/session-token-service.ts)
   - Now uses `app.service('authentication').createAccessToken()` to generate JWTs
   - Added `setApp()` method to receive app instance
   - `generateToken()` is now async
   - Still tracks tokens for revocation and use counting

2. **Removed SessionTokenStrategy** (apps/agor-daemon/src/auth/session-token-strategy.ts)
   - No longer needed - JWTs work with standard JWT strategy
   - Eliminated all socket storage complexity
   - File can be deleted (kept for now in case of rollback)

3. **Executor Client** (packages/executor/src/services/feathers-client.ts)
   - Uses `strategy: 'jwt'` instead of `strategy: 'session-token'`
   - Uses `accessToken` field instead of `sessionToken`
   - MemoryStorage still used for storing auth results

4. **Daemon Index** (apps/agor-daemon/src/index.ts)
   - Removed SessionTokenStrategy import and registration
   - Added `sessionTokenService.setApp(app)` call
   - Removed custom socket storage hooks

5. **SDK Execution** (apps/agor-daemon/src/services/sdk-execution.ts)
   - Updated to `await sessionTokenService.generateToken()` (now async)

### Why This Works

✅ **JWTs are what Feathers expects** - no custom strategy complexity
✅ **Authentication persists automatically** - Feathers handles socket storage
✅ **No race conditions** - standard JWT verification flow
✅ **Simpler codebase** - removed ~200 lines of custom strategy code

### Tradeoffs

❌ **JWT payload can be decoded** - sessionId is visible (but not sensitive)
✅ **Can still revoke tokens** - SessionTokenService tracks all issued JWTs
✅ **Can still enforce use limits** - validateToken() still checks max_uses

## Testing

Test executor authentication with:

```bash
# Trigger executor execution (should authenticate and make service calls successfully)
pnpm agor session query <session-id> "test prompt"
```

Expected logs:

```
[SessionTokenService] Generated JWT for session=xxx
[executor] Connected to daemon via Feathers client
[executor] Authenticated with session token (JWT)
✅ Authentication succeeded: { strategy: 'jwt', hasUser: true, ... }
```

No more "jwt malformed" errors!
