# Authentication & Authorization

**Status:** Implemented (Phase 2 - Multi-User Auth + Real-time Sync)
**Related:** [architecture.md](architecture.md), [models.md](models.md)

---

## ⚠️ SECURITY NOTE: Pre-1.0 Multi-User Limitations

**Given the early stage of the project, we recommend you keep Agor within trusted networks and provide access only to users you'd be confident giving the daemon's direct user access to the machine.**

**Current multi-user security limitations (as of v0.x):**

1. **No resource isolation** - Any authenticated user can access, modify, or delete any other user's sessions, tasks, worktrees, and boards. User attribution is tracked but not enforced.

2. **Shared API keys** - API keys configured at the daemon level are visible to all authenticated users. MCP tokens are stored unencrypted in the database.

3. **No rate limiting or quotas** - Users can spawn unlimited sessions, make unlimited API calls, and potentially exhaust API credits or system resources.

4. **Admin capabilities** - Users with admin role can execute arbitrary code via terminal access and environment controls under the daemon's system user account.

**Treat every invited user as having:**
- Full read/write access to all Agor data
- Access to all configured API keys
- Ability to execute code as the daemon's Unix user (if admin)

**Deployment recommendations:**
- Keep daemon behind firewall, VPN, or private network
- Only invite trusted team members
- Rotate API credentials frequently
- Use scoped/temporary credentials where possible
- Run daemon as a dedicated, scoped Unix user

**Roadmap:** True multi-tenancy with resource isolation, secure token management, rate limiting, and granular permissions are planned for v1.0.

---

## Overview

Agor uses **anonymous-first authentication** with full multi-user support - zero config required for local development, with optional authentication for shared environments.

**Philosophy:** Local-first with progressive enhancement.

**Current Capabilities:**

- ✅ User accounts with email/password authentication
- ✅ JWT tokens with automatic secret generation
- ✅ Real-time WebSocket sync for session positions
- ✅ Multi-user board collaboration
- ✅ User attribution (created_by tracking)
- ✅ User profiles with emoji avatars

---

## Current Implementation

### Anonymous Mode (Default)

By default, Agor runs in **anonymous mode** with no authentication required:

- All API requests succeed without credentials
- All operations attributed to user `'anonymous'`
- Zero configuration needed
- Appropriate for single-user local development

**Rationale:** If you control the OS, you can access `~/.agor/agor.db` directly anyway. No security theater.

### Optional Authentication

Authentication can be enabled via config when needed (shared dev servers, team environments):

```yaml
# ~/.agor/config.yaml
daemon:
  allowAnonymous: true # Allow unauthenticated access (default)
  requireAuth: false # Require authentication (opt-in)
```

---

## Authentication Strategies

### 1. Anonymous Strategy

**When:** Default mode for local development

**Implementation:** `apps/agor-daemon/src/strategies/anonymous.ts`

```typescript
// Returns virtual anonymous user with admin privileges
{
  user_id: 'anonymous',
  email: 'anonymous@localhost',
  role: 'admin',
  anonymous: true
}
```

**Configuration:**

- Enabled by default (`allowAnonymous: true`)
- Can be disabled for secure environments (`allowAnonymous: false`)

### 2. JWT Strategy

**When:** Client has previously authenticated and holds a token

**Flow:**

1. Client sends `Authorization: Bearer <jwt>` header
2. Daemon validates JWT signature and expiration
3. User extracted from token payload

**Token Lifetime:** 7 days (configurable)

### 3. Local Strategy (Username/Password)

**When:** User logging in with email + password

**Flow:**

1. Client sends `POST /authentication` with `{ strategy: 'local', email, password }`
2. Daemon looks up user by email
3. Password verified with bcrypt
4. JWT token returned

**Security:** Passwords hashed with bcrypt (10 rounds)

---

## Data Model

### Users Table

**Schema:** `packages/core/src/db/schema.ts:232-269`

```typescript
{
  user_id: string;           // UUIDv7
  email: string;             // Unique, indexed
  password: string;          // bcrypt hashed
  name?: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  avatar?: string;
  preferences?: Record<string, unknown>;
  created_at: Date;
  updated_at?: Date;
}
```

**Note:** Table only created when authentication is enabled. In anonymous mode, it doesn't exist.

### User Attribution

Sessions, tasks, and boards track who created them:

```typescript
{
  created_by: string; // user_id or 'anonymous'
}
```

**Hooks:** Automatically inject `created_by` from authenticated user or default to `'anonymous'`

**Implementation:** `apps/agor-daemon/src/index.ts:112-180`

---

## API Endpoints

### Authentication

```bash
# Login with email/password
POST /authentication
Body: { strategy: 'local', email: 'user@example.com', password: 'secret' }
Response: { accessToken: 'jwt...', user: { ... } }

# Validate JWT
POST /authentication
Body: { strategy: 'jwt', accessToken: 'jwt...' }
Response: { accessToken: 'jwt...', user: { ... } }

# Anonymous access (if enabled)
POST /authentication
Body: { strategy: 'anonymous' }
Response: { user: { user_id: 'anonymous', role: 'admin', ... } }
```

### Users Service

```bash
# List users
GET /users

# Get user by ID
GET /users/:id

# Create user
POST /users
Body: { email, password, name?, role? }

# Update user
PATCH /users/:id
Body: { email?, password?, name?, role?, avatar?, preferences? }

# Delete user
DELETE /users/:id
```

**Password Handling:**

- Passwords automatically hashed on create/update
- Password never returned in API responses (except during authentication lookup)

---

## Configuration

### JWT Secret Management

**Auto-generated on first run:**

```typescript
// If no jwtSecret in config, generate and persist
const jwtSecret = crypto.randomBytes(32).toString('hex');
await setConfigValue('daemon.jwtSecret', jwtSecret);
```

**Location:** `~/.agor/config.yaml`

**Persistence:** Secret saved to config file to maintain consistency across daemon restarts

### Auth Configuration Schema

```yaml
daemon:
  # Authentication mode
  allowAnonymous: true # Default: true (local-first)
  requireAuth: false # Default: false (opt-in)

  # JWT settings (auto-generated if missing)
  jwtSecret: 'auto-generated-hex-string'

  # JWT options
  jwtOptions:
    expiresIn: '7d' # Token lifetime
    audience: 'https://agor.dev'
    issuer: 'agor'
```

---

## Implementation Details

### FeathersJS Integration

**Setup:** `apps/agor-daemon/src/index.ts:182-223`

```typescript
import { AuthenticationService, JWTStrategy } from '@feathersjs/authentication';
import { LocalStrategy } from '@feathersjs/authentication-local';
import { AnonymousStrategy } from './strategies/anonymous';

// Configure authentication
app.set('authentication', {
  secret: jwtSecret,
  entity: 'user',
  entityId: 'user_id',
  service: 'users',
  authStrategies: ['jwt', 'local', 'anonymous'],
  local: {
    usernameField: 'email',
    passwordField: 'password',
  },
});

const authentication = new AuthenticationService(app);
authentication.register('jwt', new JWTStrategy());
authentication.register('local', new LocalStrategy());
authentication.register('anonymous', new AnonymousStrategy());

app.use('/authentication', authentication);
```

### Users Service

**Implementation:** `apps/agor-daemon/src/services/users.ts`

**Key Features:**

- bcrypt password hashing (10 rounds)
- Email uniqueness validation
- Password never exposed in responses (except auth lookup)
- Drizzle ORM for type-safe queries

**Example:**

```typescript
// Create user
const user = await usersService.create({
  email: 'user@example.com',
  password: 'plaintext', // Auto-hashed
  name: 'User Name',
  role: 'member',
});

// Password verification
const isValid = await usersService.verifyPassword(user, 'plaintext');
```

### User Attribution Hooks

**Automatic injection of `created_by`:**

```typescript
app.service('sessions').hooks({
  before: {
    create: [
      async context => {
        const userId = context.params.user?.user_id || 'anonymous';
        if (context.data && !context.data.created_by) {
          context.data.created_by = userId;
        }
        return context;
      },
    ],
  },
});
```

**Applied to:** sessions, tasks, boards

---

## Security Considerations

### Local Mode (V1/V2)

**Threat Model:**

- Attacker has OS access → Can read `~/.agor/agor.db` directly (game over)
- Attacker has network access → Low risk (daemon binds to localhost:3030)
- Multiple users on same machine → Use OS file permissions

**Mitigations:**

```bash
# Restrict database file permissions
chmod 600 ~/.agor/agor.db
chmod 700 ~/.agor/

# Daemon binds to localhost only (default)
# Only accessible from local machine
```

### JWT Token Security

**Current:**

- HS256 symmetric signing
- 7-day expiration
- Secret persisted in config file

**Protection:**

- Tokens are short-lived relative to session duration
- Secret stored on local filesystem (protected by OS permissions)
- No network transmission in local mode

---

## Real-Time Collaboration Features

### Session Position Sync (Implemented)

**Status:** ✅ Complete

Multiple users can collaborate on the same board with real-time position synchronization:

```typescript
// Board layout tracks session positions
board.layout = {
  [sessionId]: { x: number, y: number },
};
```

**Features:**

- Drag-and-drop session cards sync across all clients
- Debounced updates (500ms) reduce API calls during drag
- Last-write-wins conflict resolution
- Position persistence across page refreshes
- Smart cache invalidation prevents echo issues

**Implementation:** packages/core/src/types/board.ts:32-37, apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx

### User Attribution (Implemented)

**Status:** ✅ Complete

All entities track who created them via `created_by` field:

```typescript
{
  created_by: string; // user_id or 'anonymous'
}
```

**Applied to:** Sessions, tasks, boards

**Hooks:** Automatic injection via FeathersJS before:create hooks (apps/agor-daemon/src/index.ts:116-201)

### User Profiles (Implemented)

**Status:** ✅ Complete

Users have customizable profiles:

```typescript
{
  user_id: string;
  email: string;
  name?: string;
  emoji?: string; // User avatar (e.g., '👤', '🦄')
  role: 'owner' | 'admin' | 'member' | 'viewer';
  avatar?: string; // URL to profile image
  preferences?: Record<string, unknown>;
}
```

**UI:** Settings modal with user management table

## Future Work (Phase 3)

See [context/explorations/multiplayer-auth.md](../explorations/multiplayer-auth.md) and [context/explorations/social-features.md](../explorations/social-features.md) for planned features:

**Phase 3a - Social Features (Next):**

- **Cursor swarm** - Real-time cursor positions on canvas
- **Facepile** - Show who's active on board
- **Presence indicators** - Who's viewing/editing which session
- **Typing indicators** - Show when users are prompting

**Phase 3b - Enterprise Features (Later):**

- **OAuth providers** (GitHub, Google, generic OIDC)
- **Organizations/teams** (multi-tenancy)
- **Role-based permissions** (CASL integration)
- **Cloud deployment** (PostgreSQL, Turso/Supabase)
- **Session sharing** (board-level permissions)
- **API tokens** (for CI/CD automation)

---

## Migration Path

### V1 (No Auth) → V2 (Optional Auth)

**Status:** ✅ Complete (current implementation)

Users table exists but authentication is optional:

- Default: `allowAnonymous: true` (zero config)
- Opt-in: Set `requireAuth: true` to enforce authentication

### V2 (Optional Auth) → V3 (Cloud Multi-User)

**Status:** 📋 Planned (see explorations/multiplayer-auth.md)

Will require:

- PostgreSQL migration (from LibSQL/SQLite)
- Organizations table
- OAuth configuration
- CASL permission system
- Team/board sharing

---

## Related Documents

- [architecture.md](architecture.md) - Overall system architecture
- [models.md](models.md) - Data model definitions
- [../explorations/multiplayer-auth.md](../explorations/multiplayer-auth.md) - Future cloud auth planning

---

## References

**Implementation:**

- `apps/agor-daemon/src/index.ts` - Authentication setup
- `apps/agor-daemon/src/services/users.ts` - Users service
- `apps/agor-daemon/src/strategies/anonymous.ts` - Anonymous strategy
- `packages/core/src/db/schema.ts` - Users table schema

**Dependencies:**

- `@feathersjs/authentication` - Auth framework
- `@feathersjs/authentication-local` - Local (email/password) strategy
- `bcryptjs` - Password hashing

**External:**

- [FeathersJS Authentication](https://feathersjs.com/api/authentication/service)
- [FeathersJS Anonymous Auth](https://docs.feathersjs.com/cookbook/authentication/anonymous.html)
