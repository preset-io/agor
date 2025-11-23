# Phase 4: Credential Management - COMPLETE ✅

**Status:** Complete
**Date:** 2025-01-21
**Phase:** 4 of 6

---

## Overview

Phase 4 focused on implementing **encrypted credential management** to replace environment variable API keys with secure, per-user encrypted storage and just-in-time decryption.

---

## What Was Implemented

### 1. Users Repository with API Key Management

**File:** `packages/core/src/db/repositories/users.ts`

Created a comprehensive users repository that provides:

- ✅ Full CRUD operations for users
- ✅ Short ID resolution support
- ✅ **Encrypted API key storage** methods:
  - `getApiKey(userId, service)` - Decrypts and returns API key
  - `setApiKey(userId, service, apiKey)` - Encrypts and stores API key
  - `deleteApiKey(userId, service)` - Removes API key
- ✅ Support for three services: `anthropic`, `openai`, `gemini`
- ✅ Uses existing encryption infrastructure (`@agor/core/db/encryption`)

**Key Methods:**

```typescript
class UsersRepository {
  async getApiKey(userId: string, service: 'anthropic' | 'openai' | 'gemini'): Promise<string | null>
  async setApiKey(userId: string, service: 'anthropic' | 'openai' | 'gemini', apiKey: string): Promise<void>
  async deleteApiKey(userId: string, service: 'anthropic' | 'openai' | 'gemini'): Promise<void>
}
```

### 2. ExecutorIPCService Integration

**File:** `apps/agor-daemon/src/services/executor-ipc-service.ts`

Updated the IPC service to use encrypted credentials:

- ✅ Added `Database` dependency injection
- ✅ Created `UsersRepository` instance
- ✅ Updated `handleGetApiKey()` to:
  1. Validate session token
  2. Extract user ID from token
  3. Query encrypted API key from user's credentials
  4. Decrypt just-in-time using `UsersRepository.getApiKey()`
  5. Fallback to environment variables if not in database
- ✅ Security: API keys only decrypted when needed, never cached

**Before (Phase 3):**
```typescript
// Get from environment variables only
apiKey = process.env.ANTHROPIC_API_KEY;
```

**After (Phase 4):**
```typescript
// Get from encrypted user credentials, fallback to env
apiKey = await this.usersRepo.getApiKey(user_id, 'anthropic');
if (!apiKey) {
  apiKey = process.env.ANTHROPIC_API_KEY || null;
}
```

### 3. Test Updates

**File:** `apps/agor-daemon/test/executor-sdk-integration.test.mjs`

Updated integration test to:

- ✅ Pass `mockDb` to `ExecutorIPCService` constructor
- ✅ Maintains backward compatibility with environment variables
- ✅ Ready for future enhancement with real test database

---

## Architecture

### Credential Flow

```
User Request
    ↓
Daemon creates session token
    ↓
Daemon spawns executor
    ↓
Executor requests API key via IPC
    ↓
ExecutorIPCService validates token
    ↓
UsersRepository decrypts credential
    ↓
API key delivered just-in-time
    ↓
Executor uses key for SDK call
    ↓
Key not cached, discarded after use
```

### Security Properties

1. **Encryption at Rest**: API keys stored encrypted in database using AES-256-GCM
2. **Just-in-Time Decryption**: Keys only decrypted when requested by executor
3. **No Caching**: Keys not stored in memory after use
4. **Audit Trail**: All `get_api_key` requests logged with user ID and service
5. **Token Validation**: Session tokens validated before key delivery
6. **Graceful Fallback**: Environment variables used if database credentials not set

### Database Schema

API keys stored in existing `users` table:

```typescript
users.data: {
  api_keys?: {
    ANTHROPIC_API_KEY?: string;  // Encrypted
    OPENAI_API_KEY?: string;      // Encrypted
    GEMINI_API_KEY?: string;      // Encrypted
  }
}
```

Encryption format: `{salt}:{iv}:{authTag}:{encryptedData}` (hex-encoded)

---

## Testing

### Manual Testing

```bash
# Test with environment variable (existing flow)
ANTHROPIC_API_KEY=sk-... npx tsx test/executor-sdk-integration.test.mjs

# Future: Test with database credentials
# 1. Set AGOR_MASTER_SECRET
# 2. Store encrypted key in user record
# 3. Run test without ANTHROPIC_API_KEY env var
```

### Integration Test Status

- ✅ Executor spawns successfully
- ✅ Session token generated and validated
- ✅ API key request handled (fallback to env vars)
- ✅ Claude SDK executes via executor
- ✅ Messages streamed back to daemon

---

## What's Different from Phase 3

| Aspect | Phase 3 | Phase 4 |
|--------|---------|---------|
| **API Key Source** | Environment variables only | User credentials (encrypted) + env fallback |
| **Encryption** | None | AES-256-GCM at rest |
| **Per-User Keys** | No | Yes |
| **Decryption** | N/A | Just-in-time |
| **Repository** | None | UsersRepository with key methods |

---

## Configuration

### Master Secret (Required for Encryption)

```bash
# Set master secret for encryption
export AGOR_MASTER_SECRET="your-secret-key-here"
```

Without `AGOR_MASTER_SECRET`:
- Encryption disabled (dev mode warning)
- Falls back to environment variables
- Keys stored in plaintext (not recommended for production)

### Storing API Keys

```typescript
// Via UsersRepository
const usersRepo = new UsersRepository(db);
await usersRepo.setApiKey(userId, 'anthropic', 'sk-ant-...');
await usersRepo.setApiKey(userId, 'openai', 'sk-...');
await usersRepo.setApiKey(userId, 'gemini', 'AIza...');
```

### Future: UI for Key Management

Phase 4 provides backend infrastructure. Future work:
- User settings page for API key management
- "Add API Key" form
- Key masking in UI (`sk-ant-***...***abc`)
- Test connection button

---

## Success Criteria

### ✅ Completed

- [x] Users repository created with API key methods
- [x] Encryption/decryption integrated
- [x] ExecutorIPCService uses UsersRepository
- [x] Just-in-time credential delivery implemented
- [x] Graceful fallback to environment variables
- [x] Test updated to pass database dependency
- [x] Security: no credentials leaked to executor environment
- [x] Backward compatibility maintained

### Future Enhancements (Not in Phase 4 Scope)

- [ ] UI for managing API keys
- [ ] Credential rotation workflow
- [ ] Multiple API keys per service (e.g., team keys vs personal keys)
- [ ] Credential expiration tracking
- [ ] Usage analytics per credential

---

## Files Created/Modified

### Created
- `packages/core/src/db/repositories/users.ts` - Users repository (390 lines)

### Modified
- `packages/core/src/db/repositories/index.ts` - Export UsersRepository
- `apps/agor-daemon/src/services/executor-ipc-service.ts` - Add credential decryption
- `apps/agor-daemon/test/executor-sdk-integration.test.mjs` - Pass database to IPC service

---

## Next Steps

### Phase 5: Sessions Endpoint Integration

**Goal:** Wire up actual sessions endpoint to use ExecutorPool

**Tasks:**
1. Modify `/sessions/:id/prompt` endpoint to spawn executor
2. Generate session tokens before executor execution
3. Handle executor lifecycle in session context
4. Add feature flag: `execution.use_executor` (default: false)
5. Integration tests validating full flow through sessions endpoint
6. Permission service integration (respect user permission modes)

### Phase 6: Terminal Integration (Optional)

**Goal:** Terminal spawning via executor

**Tasks:**
1. Implement `spawn_terminal` handler in executor
2. Wire up to daemon's terminal service
3. Stream PTY output via `report_message`
4. Verify `whoami` shows correct user in terminal

---

## Summary

Phase 4 successfully implemented encrypted credential management for API keys. The infrastructure is now in place for:

- **Per-user encrypted API keys** stored in database
- **Just-in-time decryption** when executor requests credentials
- **Secure credential delivery** via IPC with session token validation
- **Zero exposure** to executor process environment

This is a significant security improvement over environment variable storage, especially for multi-user deployments. API keys are now:
- Encrypted at rest
- Decrypted only when needed
- Never cached in memory
- Fully auditable (all accesses logged)

The system maintains backward compatibility with environment variables for development and single-user setups.

**Phase 4 Status: COMPLETE ✅**
