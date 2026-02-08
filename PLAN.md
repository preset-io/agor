# Gateway Service Implementation Plan

**Goal:** Enable messaging platforms (Slack, Discord, WhatsApp) to route messages to/from Agor sessions via a "Channel" registration system.

**Core idea:** A user registers a "Channel" (e.g., "Max's Slack") in Settings. Each thread in that platform maps 1:1 to an Agor session. The gateway service handles all routing — sessions remain completely unaware of the gateway.

**Origin spec:** `agor-claw/private-personal-assistant/ideas/GATEWAY-SERVICE-SPEC.md` (written semi-blind of Agor internals — this plan adapts it to match actual patterns).

---

## Architecture

```
Messaging Platforms (Slack, Discord, etc.)
         │
         ▼
┌─────────────────────┐
│   Gateway Service   │  ← Part of agor-daemon (not separate process)
│                     │
│  gateway_channels   │  ← User-registered channel configs
│  thread_session_map │  ← Runtime thread↔session mappings
│  Provider Connectors│  ← Slack/Discord/etc. adapters
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│   Agor Sessions     │  ← Sessions are UNAWARE of gateway
│   (standard CRUD)   │  ← No gateway metadata in sessions
└─────────────────────┘
```

**Key design decision:** Sessions don't store gateway info. The gateway service owns the `thread_session_map` table. On every assistant message, the messages service hook calls `gateway.routeMessage(sessionId, message)` — if no mapping exists, it's a cheap no-op lookup and discard.

---

## Phase 1: Database Schema & Types

### 1.1 Types — `packages/core/src/types/gateway.ts`

New branded ID types and interfaces:

```typescript
// ID types (follow existing UUID pattern from id.ts)
export type GatewayChannelID = UUID;
export type ThreadSessionMapID = UUID;

// Enums
export type ChannelType = 'slack' | 'discord' | 'whatsapp' | 'telegram';
export type ThreadStatus = 'active' | 'archived' | 'paused';

// Core types
export interface GatewayChannel {
  id: GatewayChannelID;
  created_by: string;
  name: string;
  channel_type: ChannelType;
  target_worktree_id: WorktreeID;
  agor_user_id: UserID;
  channel_key: string;          // UUID — the auth secret for inbound webhooks
  config: Record<string, unknown>;  // Platform credentials (encrypted at rest)
  enabled: boolean;
  created_at: string;           // ISO 8601
  updated_at: string;           // ISO 8601
  last_message_at: string | null;
}

export interface ThreadSessionMap {
  id: ThreadSessionMapID;
  channel_id: GatewayChannelID;
  thread_id: string;            // Platform-specific (e.g., "C123456-1707340800.123456")
  session_id: SessionID;
  worktree_id: WorktreeID;
  created_at: string;
  last_message_at: string;
  status: ThreadStatus;
  metadata: Record<string, unknown> | null;
}
```

**Export from:** `packages/core/src/types/index.ts` (add `export * from './gateway'`)

### 1.2 Schema — both `schema.sqlite.ts` and `schema.postgres.ts`

Two new tables following existing patterns (hybrid materialized + JSON):

**`gateway_channels` table:**
- `id` text PK (36 chars, UUIDv7)
- `created_by` text NOT NULL DEFAULT 'anonymous'
- `name` text NOT NULL
- `channel_type` text NOT NULL (enum: slack/discord/whatsapp/telegram)
- `target_worktree_id` text NOT NULL FK → worktrees (CASCADE delete)
- `agor_user_id` text NOT NULL
- `channel_key` text NOT NULL UNIQUE
- `config` json NOT NULL (encrypted platform credentials)
- `enabled` bool NOT NULL DEFAULT true
- `created_at` timestamp NOT NULL
- `updated_at` timestamp NOT NULL
- `last_message_at` timestamp (nullable)

Indexes:
- `idx_gateway_channel_key` on (channel_key) — fast auth lookup
- `idx_gateway_enabled_type` on (enabled, channel_type)

**`thread_session_map` table:**
- `id` text PK (36 chars, UUIDv7)
- `channel_id` text NOT NULL FK → gateway_channels (CASCADE delete)
- `thread_id` text NOT NULL
- `session_id` text NOT NULL FK → sessions
- `worktree_id` text NOT NULL FK → worktrees
- `created_at` timestamp NOT NULL
- `last_message_at` timestamp NOT NULL
- `status` text NOT NULL DEFAULT 'active'
- `metadata` json (nullable)

Indexes:
- `uniq_thread_map_channel_thread` on (channel_id, thread_id) — unique constraint
- `idx_thread_map_session_id` on (session_id) — outbound routing lookup
- `idx_thread_map_channel_status` on (channel_id, status)

### 1.3 Schema barrel export — `packages/core/src/db/schema.ts`

Add re-exports:
```typescript
export const gatewayChannels = schema.gatewayChannels;
export const threadSessionMap = schema.threadSessionMap;
```

### 1.4 Generate migration

```bash
cd packages/core
pnpm db:generate  # generates both sqlite + postgres migrations
```

---

## Phase 2: Repository Layer

### 2.1 `packages/core/src/db/repositories/gateway-channels.ts`

Implements `BaseRepository<GatewayChannel, Partial<GatewayChannel>>`.

Pattern: follow `BoardRepository` exactly (rowToX, xToInsert, resolveId, CRUD).

Key methods beyond CRUD:
- `findByKey(channelKey: string): Promise<GatewayChannel | null>` — auth lookup
- `findByUser(userId: string): Promise<GatewayChannel[]>` — list user's channels
- `updateLastMessage(id: GatewayChannelID): Promise<void>` — touch timestamp

Encryption: use existing `encryptApiKey()` / `decryptApiKey()` from `packages/core/src/db/encryption.ts` for the `config` JSON blob. Encrypt individual sensitive fields within config (bot_token, app_token, signing_secret) on write, decrypt on read.

### 2.2 `packages/core/src/db/repositories/thread-session-map.ts`

Implements `BaseRepository<ThreadSessionMap, Partial<ThreadSessionMap>>`.

Key methods beyond CRUD:
- `findByChannelAndThread(channelId, threadId): Promise<ThreadSessionMap | null>` — inbound routing
- `findBySession(sessionId): Promise<ThreadSessionMap | null>` — outbound routing
- `findByChannel(channelId, status?): Promise<ThreadSessionMap[]>` — list threads
- `updateLastMessage(id): Promise<void>` — touch timestamp
- `findInactive(daysInactive: number): Promise<ThreadSessionMap[]>` — garbage collection

### 2.3 Export from `packages/core/src/db/repositories/index.ts`

Add:
```typescript
export * from './gateway-channels';
export * from './thread-session-map';
```

---

## Phase 3: Service Layer (Daemon)

### 3.1 `apps/agor-daemon/src/services/gateway-channels.ts`

FeathersJS service using DrizzleService adapter (like BoardsService, MCPServersService).

```typescript
export class GatewayChannelsService extends DrizzleService<GatewayChannel> {
  // Override create() to:
  //   1. Generate channel_key (UUIDv7)
  //   2. Encrypt sensitive config fields
  //   3. Set timestamps

  // Override get()/find() to:
  //   1. NEVER return decrypted config in list responses
  //   2. Only return decrypted config for single get() by owner

  // Custom method: rotateKey(id) — generate new channel_key
}
```

Register at: `app.use('gateway-channels', gatewayChannelsService)`

### 3.2 `apps/agor-daemon/src/services/thread-session-map.ts`

Standard DrizzleService for CRUD on thread mappings. Mostly admin/monitoring.

Register at: `app.use('thread-session-map', threadSessionMapService)`

### 3.3 `apps/agor-daemon/src/services/gateway.ts`

**Core routing service** — custom service (not DrizzleService, since it orchestrates across multiple repos).

Two main methods:

**`postMessage(data)` — Inbound (platform → session)**
1. Authenticate via `channel_key` lookup
2. Check channel enabled
3. Look up thread in `thread_session_map`
4. If no mapping: create session in `target_worktree_id`, create mapping
5. Send prompt to session (via sessions service)
6. Touch `last_message_at` timestamps
7. Return `{ success, sessionId, created }`

**`routeMessage(data)` — Outbound (session → platform)**
1. Look up session in `thread_session_map` by `session_id`
2. If no mapping → return `{ routed: false }` (cheap no-op)
3. Get channel config, get connector
4. Send message to platform thread
5. Touch timestamps
6. Return `{ routed: true, channelType, messageId }`

Register at: `app.use('gateway', gatewayService)`

### 3.4 Message routing hook

**File:** `apps/agor-daemon/src/hooks/gateway-route.ts`

FeathersJS `after` hook on the messages service `create` method:
- Check if `message.role === 'assistant'`
- Call `app.service('gateway').routeMessage(...)` (fire-and-forget, catch errors)
- Non-blocking — don't slow down message creation

Register in daemon index.ts on messages service hooks.

---

## Phase 4: Provider Connectors

### 4.1 Connector interface — `packages/core/src/gateway/connector.ts`

```typescript
export interface GatewayConnector {
  readonly channelType: ChannelType;

  sendMessage(req: {
    threadId: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<string>;  // Returns platform message ID

  // Optional: active listening (Socket Mode, etc.)
  startListening?(callback: (msg: InboundMessage) => void): Promise<void>;
  stopListening?(): Promise<void>;

  // Optional: markdown → platform formatting
  formatMessage?(markdown: string): string;
}

export interface InboundMessage {
  threadId: string;
  userId: string;
  userName?: string;
  text: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
```

### 4.2 Slack connector — `packages/core/src/gateway/connectors/slack.ts`

Uses `@slack/web-api` and optionally `@slack/socket-mode`.

- `sendMessage()` — parse threadId format `{channel}-{thread_ts}`, call `chat.postMessage`
- `startListening()` — Socket Mode event listener, filter for bot mentions / DMs
- `formatMessage()` — convert markdown → Slack mrkdwn (basic: bold, code blocks, links)

Dependencies to add: `@slack/web-api`, `@slack/socket-mode`

### 4.3 Connector registry — `packages/core/src/gateway/connector-registry.ts`

Simple factory that returns connector instances by channel type:
```typescript
const connectors = new Map<string, (config) => GatewayConnector>();
connectors.set('slack', (config) => new SlackConnector(config));
// Future: discord, whatsapp, telegram
```

---

## Phase 5: Settings UI

### 5.1 New Settings tab — `apps/agor-ui/src/components/SettingsModal/GatewayChannelsTable.tsx`

Follow `MCPServersTable.tsx` pattern (closest analog — also has encrypted config, CRUD, multiple types).

**Channel list view:**
- Table with columns: Status (green/red dot), Name, Type, Target Worktree, Active Threads, Last Message
- Actions: Edit, Enable/Disable, Delete

**Create/Edit modal:**
- Channel Type selector (Slack, Discord, etc.)
- Name input
- Target Worktree dropdown
- Post messages as (user dropdown)
- Platform-specific config section (conditional on channel_type):
  - Slack: Bot Token, App Token, Connection Mode (Socket/Webhook)
  - Discord: Bot Token, Guild ID
  - etc.

**Post-create success view:**
- Show generated channel_key
- Show setup instructions based on channel type
- "Keep this key secret" warning

### 5.2 Register in SettingsModal.tsx

Add to `menuItems` under "Integrations" group:
```typescript
{
  key: 'gateway',
  label: 'Gateway Channels',
  icon: <GatewayOutlined />,  // or MessageOutlined or similar
}
```

Add switch case in `renderContent()`.

Add callback props: `onCreateGatewayChannel`, `onUpdateGatewayChannel`, `onDeleteGatewayChannel`.

### 5.3 State management — `apps/agor-ui/src/hooks/useAgorData.ts`

Add:
- `gatewayChannelById` Map
- WebSocket listeners for `gateway-channels` service events
- Feathers service calls for CRUD

---

## Phase 6: Service Registration in Daemon

### `apps/agor-daemon/src/index.ts`

Add imports and registration:
```typescript
import { GatewayChannelsRepository, ThreadSessionMapRepository } from '@agor/core/db';

// Create repositories
const gatewayChannelRepo = new GatewayChannelsRepository(db);
const threadSessionMapRepo = new ThreadSessionMapRepository(db);

// Create and register services
app.use('gateway-channels', new GatewayChannelsService(db));
app.use('thread-session-map', new ThreadSessionMapService(db));
app.use('gateway', new GatewayService(db, app));

// Add query validator hooks
app.service('gateway-channels').hooks({ before: { find: [validateQuery(gatewayChannelQueryValidator)] }});

// Add gateway routing hook to messages service
app.service('messages').hooks({ after: { create: [gatewayRouteHook] }});
```

---

## Implementation Order

Start with the data layer and work up:

1. **Types** (`gateway.ts`) — defines the contracts
2. **Schema** (both sqlite + postgres) — add tables, generate migration
3. **Repositories** (gateway-channels, thread-session-map) — data access
4. **Services** (gateway-channels CRUD, gateway routing) — business logic
5. **UI** (GatewayChannelsTable in Settings) — user-facing channel management
6. **Slack connector** — first provider implementation
7. **Message routing hook** — wire outbound routing
8. **End-to-end testing** — Slack → session → Slack

---

## What We're NOT Doing (Spec Divergences)

| Spec says | We're doing instead | Why |
|-----------|---------------------|-----|
| Store gateway metadata in `session.data` | No gateway info in sessions | Sessions should be unaware; gateway owns the mapping |
| Separate encryption key (`GATEWAY_ENCRYPTION_KEY`) | Reuse `AGOR_MASTER_SECRET` via `encryptApiKey()`/`decryptApiKey()` | Existing pattern, no new config needed |
| Separate gateway process | Part of agor-daemon | Follows daemon extension pattern |
| Custom rate limiting middleware | Defer to Phase 2 | Get core routing working first |
| CLI commands (`agor gateway ...`) | Defer to Phase 2 | UI-first, CLI later |
| Multiple platform connectors at once | Slack only first | Prove the pattern, then extend |

---

## Config Requirements

The gateway service requires:
- **Auth enabled** — channels reference `agor_user_id` and `created_by`
- **`AGOR_MASTER_SECRET`** — for encrypting platform credentials in `config` column
- **Slack App** — Bot Token + App Token for Socket Mode (user provides during channel creation)

No new config.yaml fields needed. The gateway is always available as a daemon service; channels are user-created resources.

---

## File Inventory (New Files)

```
packages/core/src/types/gateway.ts                          # Types
packages/core/src/db/schema.sqlite.ts                       # Add tables (edit)
packages/core/src/db/schema.postgres.ts                     # Add tables (edit)
packages/core/src/db/schema.ts                              # Add exports (edit)
packages/core/src/db/repositories/gateway-channels.ts       # Repository
packages/core/src/db/repositories/thread-session-map.ts     # Repository
packages/core/src/db/repositories/index.ts                  # Add exports (edit)
packages/core/src/types/index.ts                            # Add export (edit)
packages/core/src/gateway/connector.ts                      # Connector interface
packages/core/src/gateway/connectors/slack.ts               # Slack connector
packages/core/src/gateway/connector-registry.ts             # Factory
apps/agor-daemon/src/services/gateway-channels.ts           # CRUD service
apps/agor-daemon/src/services/thread-session-map.ts         # CRUD service
apps/agor-daemon/src/services/gateway.ts                    # Routing service
apps/agor-daemon/src/hooks/gateway-route.ts                 # Message hook
apps/agor-daemon/src/index.ts                               # Register services (edit)
apps/agor-ui/src/components/SettingsModal/GatewayChannelsTable.tsx  # UI
apps/agor-ui/src/components/SettingsModal/SettingsModal.tsx  # Add tab (edit)
apps/agor-ui/src/hooks/useAgorData.ts                       # Add state (edit)
```

**New files:** 10
**Edited files:** 8
**New dependencies:** `@slack/web-api`, `@slack/socket-mode`
