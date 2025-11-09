# Per-User Environment Variables

**Status**: Ready for Implementation
**Created**: 2025-11-01
**Author**: Claude (Session 019a3af2)
**Decisions Finalized**: 2025-11-01

---

## Executive Summary

This document proposes adding **per-user environment variables** to Agor, enabling users to configure arbitrary environment variables (like `GITHUB_API_KEY`, `NPM_TOKEN`, etc.) that will be available to:

1. **Agentic coding tools** (Claude, Codex, Gemini) when they spawn subprocesses
2. **Terminal sessions** created via the Terminal Modal
3. **Environment commands** (start/stop/health checks for worktrees)

The proposal builds on the existing per-user API key infrastructure (encryption, UI patterns, precedence) while extending it to support arbitrary key-value pairs.

---

## MVP Scope - Implementation Decisions ✅

All key decisions have been made and documented below:

### ✅ **What's Included in MVP**

1. **UI Pattern:** Accumulator pattern (table view + add form) - see `context/concepts/design.md`
2. **Encryption:** Reuse existing AES-256-GCM infrastructure (same as API keys)
3. **Storage:** `users.data.env_vars` JSON blob (no migration needed)
4. **Integration:** Terminal PTY + Claude/Codex/Gemini SDKs
5. **Security:** Blocklist for dangerous vars (`PATH`, `SHELL`, `LD_PRELOAD`, etc.)
6. **Validation:** Uppercase naming convention (`^[A-Z_][A-Z0-9_]*$`), 10KB limit
7. **Locking:** Per-user locks to prevent process.env race conditions
8. **SDK Method:** process.env augmentation approach (works with all SDKs)

### ⏭️ **What's Deferred to v2**

1. Global environment variables (admin-configurable, team-wide)
2. Audit logging (who changed what when)
3. Environment variable templates (dropdown with common vars)
4. SDK custom env injection (optimize if SDKs add support)

### 📊 **Estimated Effort**

**Total:** 28-39 hours across 4 sprints

- Sprint 1: Backend infrastructure (7-10h)
- Sprint 2: UI component (4-5h)
- Sprint 3: Integration (8-11h)
- Sprint 4: Testing & polish (9-13h)

**See "Implementation Decisions" section below for detailed rationale.**

---

## Problem Statement

### Current State

Users can set per-user API keys for agentic tools (Anthropic, OpenAI, Gemini), but there's no way to configure other environment variables that agents commonly need:

- `GITHUB_API_KEY` / `GITHUB_TOKEN` - For GitHub CLI (`gh`) operations
- `NPM_TOKEN` - For private npm registry access
- `DOCKER_HOST` - For custom Docker daemon URLs
- `DATABASE_URL` - For local database connections
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` - For cloud operations
- Custom env vars for project-specific tooling

### Use Cases

**1. GitHub CLI Operations**

When Claude Code runs `gh pr create`, it needs a GitHub token to authenticate. Currently:

- ❌ User must manually run `gh auth login` in each environment
- ❌ Token stored in `~/.config/gh/hosts.yml` (not per-user in Agor)
- ❌ Shared machine = security risk (token visible to all users)

With per-user env vars:

- ✅ User sets `GITHUB_TOKEN` in their profile (encrypted)
- ✅ All agent subprocess calls inherit this token
- ✅ Terminal sessions automatically have access
- ✅ Secure per-user isolation

**2. Private Package Registries**

When Codex runs `npm install` for a project with private packages:

- ❌ User must configure `.npmrc` manually
- ❌ Token stored in plaintext in project files (git security risk)

With per-user env vars:

- ✅ User sets `NPM_TOKEN` in their profile
- ✅ Agent subprocess calls inherit the token
- ✅ No plaintext secrets in project files

**3. Cloud/Database Access**

When agents need to interact with cloud services or databases:

- ❌ Each user must configure credentials separately
- ❌ No central management in Agor

With per-user env vars:

- ✅ Users configure their own AWS/GCP/database credentials
- ✅ Encrypted at rest in Agor database
- ✅ Automatically available to all agent operations

---

## Proposed Solution

### High-Level Design

Extend the existing per-user API key system to support **arbitrary environment variables**:

```typescript
// Current API keys (specific keys)
api_keys: {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

// NEW: Arbitrary environment variables
env_vars: {
  [key: string]: string; // Encrypted key-value pairs
}
```

**Key Design Principles:**

1. **Reuse encryption infrastructure** - Use existing `encryptApiKey()` / `decryptApiKey()` from per-user API keys
2. **Separate storage** - Keep `env_vars` distinct from `api_keys` (different UI, different purpose)
3. **Merge at runtime** - Combine with `process.env` when spawning subprocesses
4. **Precedence order** - User env vars > Global env vars > System env vars
5. **Security-first** - Encrypt at rest, never expose in logs/responses

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ User Profile (Database)                                      │
│                                                              │
│  users.data:                                                 │
│    - api_keys: { ANTHROPIC_API_KEY: "enc:..." }            │
│    - env_vars: { GITHUB_TOKEN: "enc:...", ... }            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Runtime Environment Resolution                               │
│                                                              │
│  resolveUserEnvironment(userId, db):                        │
│    1. Fetch user.data.env_vars from database                │
│    2. Decrypt all values                                    │
│    3. Merge with system process.env                         │
│    4. Return combined env object                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
     ┌──────────┐   ┌──────────┐   ┌──────────┐
     │ Claude   │   │ Terminal │   │ Worktree │
     │ SDK      │   │ PTY      │   │ Env Cmds │
     │          │   │          │   │          │
     │ Spawns   │   │ Spawns   │   │ Spawns   │
     │ gh, npm  │   │ bash     │   │ docker   │
     └──────────┘   └──────────┘   └──────────┘
         │               │               │
         └───────────────┴───────────────┘
                    │
         All inherit user env vars
```

---

## Technical Design

### 1. Database Schema

**Extend `users.data` JSON blob** (no migration needed):

```typescript
// packages/core/src/db/schema.ts
data: text('data', { mode: 'json' })
  .$type<{
    avatar?: string;
    preferences?: Record<string, unknown>;
    api_keys?: {
      ANTHROPIC_API_KEY?: string;
      OPENAI_API_KEY?: string;
      GEMINI_API_KEY?: string;
    };
    // NEW: Arbitrary environment variables (encrypted)
    env_vars?: Record<string, string>; // { "GITHUB_TOKEN": "enc:...", "NPM_TOKEN": "enc:..." }
  }>()
  .notNull(),
```

**Rationale:**

- ✅ Flexible schema (no pre-defined keys)
- ✅ Same encryption as API keys
- ✅ No database migration needed
- ✅ Consistent with existing patterns

### 2. Type Definitions

**Extend User types** (`packages/core/src/types/user.ts`):

```typescript
export interface User {
  user_id: UserID;
  email: string;
  // ... existing fields ...

  // API key status (boolean only)
  api_keys?: {
    ANTHROPIC_API_KEY?: boolean;
    OPENAI_API_KEY?: boolean;
    GEMINI_API_KEY?: boolean;
  };

  // NEW: Environment variable keys (boolean status, NOT values)
  env_vars?: Record<string, boolean>; // { "GITHUB_TOKEN": true, "NPM_TOKEN": false }
}

export interface UpdateUserInput {
  // ... existing fields ...

  // API keys (accepts plaintext, encrypted before storage)
  api_keys?: {
    ANTHROPIC_API_KEY?: string | null;
    OPENAI_API_KEY?: string | null;
    GEMINI_API_KEY?: string | null;
  };

  // NEW: Environment variables (accepts plaintext, encrypted before storage)
  env_vars?: Record<string, string | null>; // { "GITHUB_TOKEN": "ghp_...", "NPM_TOKEN": null }
}
```

**Important:**

- User type returns **boolean status** (keys present, values hidden)
- UpdateUserInput accepts **plaintext values** (encrypted by service)
- `null` value **clears** a variable, `undefined` **ignores** it

### 3. UI Components

#### 3.1 Reusable Env Var Editor Component

**New Component**: `apps/agor-ui/src/components/EnvVarEditor.tsx`

```tsx
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Input, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';

export interface EnvVarEditorProps {
  /** Current env vars (key → isSet boolean) */
  envVars: Record<string, boolean>;
  /** Callback when user adds/updates a variable */
  onSave: (key: string, value: string) => Promise<void>;
  /** Callback when user deletes a variable */
  onDelete: (key: string) => Promise<void>;
  /** Loading state for operations */
  loading?: Record<string, boolean>;
  /** Disable all fields */
  disabled?: boolean;
}

export const EnvVarEditor: React.FC<EnvVarEditorProps> = ({
  envVars,
  onSave,
  onDelete,
  loading = {},
  disabled = false,
}) => {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return;
    await onSave(newKey.trim(), newValue.trim());
    setNewKey('');
    setNewValue('');
  };

  const handleUpdate = async (key: string) => {
    if (!editingValue.trim()) return;
    await onSave(key, editingValue.trim());
    setEditingKey(null);
    setEditingValue('');
  };

  const columns = [
    {
      title: 'Variable Name',
      dataIndex: 'key',
      key: 'key',
      width: '30%',
      render: (key: string) => <code>{key}</code>,
    },
    {
      title: 'Value',
      dataIndex: 'isSet',
      key: 'value',
      width: '40%',
      render: (isSet: boolean, record: { key: string }) => {
        const isEditing = editingKey === record.key;

        if (isEditing) {
          return (
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password
                placeholder="Enter new value"
                value={editingValue}
                onChange={e => setEditingValue(e.target.value)}
                onPressEnter={() => handleUpdate(record.key)}
                autoFocus
                disabled={disabled}
              />
              <Button
                type="primary"
                onClick={() => handleUpdate(record.key)}
                loading={loading[record.key]}
                disabled={disabled || !editingValue.trim()}
              >
                Save
              </Button>
              <Button onClick={() => setEditingKey(null)} disabled={disabled}>
                Cancel
              </Button>
            </Space.Compact>
          );
        }

        return (
          <Space>
            <Tag color={isSet ? 'success' : 'default'}>{isSet ? 'Set (encrypted)' : 'Not Set'}</Tag>
            {isSet && (
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setEditingKey(record.key);
                  setEditingValue('');
                }}
                disabled={disabled}
              >
                Update
              </Button>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: '30%',
      render: (_: unknown, record: { key: string }) => (
        <Button
          danger
          icon={<DeleteOutlined />}
          onClick={() => onDelete(record.key)}
          loading={loading[record.key]}
          disabled={disabled}
        >
          Delete
        </Button>
      ),
    },
  ];

  const dataSource = Object.entries(envVars).map(([key, isSet]) => ({
    key,
    isSet,
  }));

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary">
        Environment variables are encrypted at rest and available to all agent operations
        (subprocesses, terminal sessions, environment commands).
      </Typography.Paragraph>

      {/* Existing Variables Table */}
      <Table
        columns={columns}
        dataSource={dataSource}
        pagination={false}
        size="small"
        locale={{ emptyText: 'No environment variables configured' }}
      />

      {/* Add New Variable Form */}
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Typography.Text strong>Add New Variable</Typography.Text>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            placeholder="Variable name (e.g., GITHUB_TOKEN)"
            value={newKey}
            onChange={e => setNewKey(e.target.value)}
            onPressEnter={handleAdd}
            style={{ width: '30%' }}
            disabled={disabled}
          />
          <Input.Password
            placeholder="Value"
            value={newValue}
            onChange={e => setNewValue(e.target.value)}
            onPressEnter={handleAdd}
            style={{ flex: 1 }}
            disabled={disabled}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleAdd}
            disabled={disabled || !newKey.trim() || !newValue.trim()}
          >
            Add
          </Button>
        </Space.Compact>
      </Space>
    </Space>
  );
};
```

**Features:**

- ✅ Table view of existing variables (name + status)
- ✅ Inline editing with password-masked input
- ✅ Add new variable form at bottom
- ✅ Delete confirmation
- ✅ Loading states for async operations
- ✅ Shows encrypted status (never displays actual values)

#### 3.2 Integration into User Edit Modal

**Update `apps/agor-ui/src/components/SettingsModal/UsersTable.tsx`**:

Add a new collapsed section below the API Keys section:

```tsx
<Form.Item label="Environment Variables">
  <Collapse
    ghost
    items={[
      {
        key: 'env-vars',
        label: 'Configure Environment Variables',
        children: (
          <div style={{ paddingTop: 8 }}>
            <EnvVarEditor
              envVars={userEnvVars}
              onSave={handleEnvVarSave}
              onDelete={handleEnvVarDelete}
              loading={savingEnvVars}
            />
          </div>
        ),
      },
    ]}
  />
</Form.Item>
```

**Handlers:**

```tsx
const [userEnvVars, setUserEnvVars] = useState<Record<string, boolean>>({});
const [savingEnvVars, setSavingEnvVars] = useState<Record<string, boolean>>({});

// Load user's env vars when editing
useEffect(() => {
  if (editingUser?.env_vars) {
    setUserEnvVars(editingUser.env_vars);
  } else {
    setUserEnvVars({});
  }
}, [editingUser]);

const handleEnvVarSave = async (key: string, value: string) => {
  if (!editingUser) return;

  try {
    setSavingEnvVars(prev => ({ ...prev, [key]: true }));
    await onUpdate?.(editingUser.user_id, {
      env_vars: { [key]: value },
    });
    setUserEnvVars(prev => ({ ...prev, [key]: true }));
  } finally {
    setSavingEnvVars(prev => ({ ...prev, [key]: false }));
  }
};

const handleEnvVarDelete = async (key: string) => {
  if (!editingUser) return;

  try {
    setSavingEnvVars(prev => ({ ...prev, [key]: true }));
    await onUpdate?.(editingUser.user_id, {
      env_vars: { [key]: null },
    });
    setUserEnvVars(prev => {
      const updated = { ...prev };
      delete updated[key];
      return updated;
    });
  } finally {
    setSavingEnvVars(prev => ({ ...prev, [key]: false }));
  }
};
```

### 4. Backend Services

#### 4.1 Update Users Service

**Extend `apps/agor-daemon/src/services/users.ts`**:

Add encryption/decryption for `env_vars` (same pattern as `api_keys`):

```typescript
async patch(id: UserID, data: UpdateUserData, _params?: Params): Promise<User> {
  const now = new Date();
  const updates: Record<string, unknown> = { updated_at: now };

  // ... existing password/email/name/role handling ...

  // Update data blob
  if (data.avatar || data.preferences || data.api_keys || data.env_vars) {
    const current = await this.get(id);
    const currentData = current.data as {
      avatar?: string;
      preferences?: Record<string, unknown>;
      api_keys?: Record<string, string>;
      env_vars?: Record<string, string>; // NEW
    };

    // Handle API keys (existing logic)
    let encryptedKeys = currentData.api_keys || {};
    if (data.api_keys) {
      for (const [key, value] of Object.entries(data.api_keys)) {
        if (value === null || value === undefined) {
          delete encryptedKeys[key];
        } else {
          encryptedKeys[key] = encryptApiKey(value);
        }
      }
    }

    // NEW: Handle env vars (same encryption pattern)
    let encryptedEnvVars = currentData.env_vars || {};
    if (data.env_vars) {
      for (const [key, value] of Object.entries(data.env_vars)) {
        if (value === null || value === undefined) {
          // Clear variable
          delete encryptedEnvVars[key];
          console.log(`🗑️  Cleared user env var: ${key}`);
        } else {
          // Encrypt and store
          try {
            encryptedEnvVars[key] = encryptApiKey(value);
            console.log(`🔐 Encrypted user env var: ${key}`);
          } catch (err) {
            console.error(`Failed to encrypt env var ${key}:`, err);
            throw new Error(`Failed to encrypt environment variable: ${key}`);
          }
        }
      }
    }

    updates.data = {
      avatar: data.avatar ?? currentData.avatar,
      preferences: data.preferences ?? currentData.preferences,
      api_keys: Object.keys(encryptedKeys).length > 0 ? encryptedKeys : undefined,
      env_vars: Object.keys(encryptedEnvVars).length > 0 ? encryptedEnvVars : undefined, // NEW
    };
  }

  // ... rest of method unchanged ...
}

/**
 * Convert database row to User type
 */
private rowToUser(
  row: typeof users.$inferSelect,
  includePassword = false
): User & { password?: string } {
  const data = row.data as {
    avatar?: string;
    preferences?: Record<string, unknown>;
    api_keys?: Record<string, string>;
    env_vars?: Record<string, string>; // NEW
  };

  const user: User & { password?: string } = {
    user_id: row.user_id as UserID,
    email: row.email,
    // ... existing fields ...

    // Return API key status (boolean), NOT actual keys
    api_keys: data.api_keys
      ? {
          ANTHROPIC_API_KEY: !!data.api_keys.ANTHROPIC_API_KEY,
          OPENAI_API_KEY: !!data.api_keys.OPENAI_API_KEY,
          GEMINI_API_KEY: !!data.api_keys.GEMINI_API_KEY,
        }
      : undefined,

    // NEW: Return env var status (boolean), NOT actual values
    env_vars: data.env_vars
      ? Object.fromEntries(
          Object.keys(data.env_vars).map(key => [key, true])
        )
      : undefined,
  };

  // ... rest of method unchanged ...
}

/**
 * NEW: Get decrypted environment variables for a user
 * Used by subprocess spawning, terminal sessions, etc.
 */
async getEnvironmentVariables(userId: UserID): Promise<Record<string, string>> {
  const row = await this.db.select().from(users).where(eq(users.user_id, userId)).get();

  if (!row) return {};

  const data = row.data as { env_vars?: Record<string, string> };
  const encryptedVars = data.env_vars;

  if (!encryptedVars) return {};

  const decryptedVars: Record<string, string> = {};

  for (const [key, encryptedValue] of Object.entries(encryptedVars)) {
    try {
      decryptedVars[key] = decryptApiKey(encryptedValue);
    } catch (err) {
      console.error(`Failed to decrypt env var ${key} for user ${userId}:`, err);
      // Skip this variable (don't crash)
    }
  }

  return decryptedVars;
}
```

#### 4.2 Create Environment Resolution Utility

**New file**: `packages/core/src/config/env-resolver.ts`

```typescript
import type { Database } from '../db/client';
import { eq, users } from '../db/schema';
import { decryptApiKey } from '../db/encryption';
import type { UserID } from '../types';

/**
 * Resolve full environment for a user, combining:
 * 1. User-specific env vars (from database, encrypted)
 * 2. System process.env (from daemon startup)
 *
 * User env vars take precedence over system env vars.
 *
 * @param userId - User ID to resolve environment for
 * @param db - Database instance
 * @returns Combined environment object (user + system)
 */
export async function resolveUserEnvironment(
  userId: UserID,
  db: Database
): Promise<Record<string, string>> {
  // Start with system environment
  const env: Record<string, string> = { ...process.env } as Record<string, string>;

  // Fetch user's encrypted env vars
  try {
    const row = await db.select().from(users).where(eq(users.user_id, userId)).get();

    if (row) {
      const data = row.data as { env_vars?: Record<string, string> };
      const encryptedVars = data.env_vars;

      if (encryptedVars) {
        for (const [key, encryptedValue] of Object.entries(encryptedVars)) {
          try {
            // Decrypt and merge (user env vars override system)
            env[key] = decryptApiKey(encryptedValue);
          } catch (err) {
            console.error(`Failed to decrypt env var ${key} for user ${userId}:`, err);
            // Skip this variable (don't crash)
          }
        }
      }
    }
  } catch (err) {
    console.error(`Failed to resolve environment for user ${userId}:`, err);
    // Fall back to system env only
  }

  return env;
}

/**
 * Synchronous version (for contexts where async not available)
 * Only returns system env (no per-user env vars)
 */
export function resolveSystemEnvironment(): Record<string, string> {
  return { ...process.env } as Record<string, string>;
}
```

**Export from config:**

```typescript
// packages/core/src/config/index.ts
export * from './config-manager';
export * from './key-resolver';
export * from './env-resolver'; // NEW
export * from './types';
```

### 5. Integration Points

#### 5.1 Terminal Service (PTY)

**Update `apps/agor-daemon/src/services/terminals.ts`**:

```typescript
import { resolveUserEnvironment } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import type { UserID } from '@agor/core/types';

interface CreateTerminalData {
  cwd?: string;
  shell?: string;
  rows?: number;
  cols?: number;
  userId?: UserID; // NEW: User context for env resolution
}

export class TerminalsService {
  private sessions = new Map<string, TerminalSession>();
  private app: Application;
  private db: Database; // NEW: Database for env resolution

  constructor(app: Application, db: Database) {
    this.app = app;
    this.db = db;
  }

  async create(data: CreateTerminalData): Promise<{ terminalId: string; cwd: string }> {
    const terminalId = `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const cwd = data.cwd || os.homedir();
    const shell = data.shell || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');

    // NEW: Resolve environment with user env vars
    let env: Record<string, string> = process.env as Record<string, string>;
    if (data.userId) {
      env = await resolveUserEnvironment(data.userId, this.db);
      console.log(
        `🔐 Loaded ${Object.keys(env).length} env vars for user ${data.userId.substring(0, 8)}`
      );
    }

    // Spawn PTY process with merged environment
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: data.cols || 80,
      rows: data.rows || 30,
      cwd,
      env, // NEW: Use resolved environment
    });

    // ... rest of method unchanged ...
  }
}
```

**Update service registration** (`apps/agor-daemon/src/index.ts`):

```typescript
// Pass database to TerminalsService
app.use('terminals', new TerminalsService(app, db));
```

**Update UI to pass userId** (`apps/agor-ui/src/components/TerminalModal/TerminalModal.tsx`):

```typescript
// Get current user from context/state
const currentUser = useCurrentUser(); // Assume this hook exists

// Pass userId when creating terminal
const result = await client.service('terminals').create({
  rows: 30,
  cols: 100,
  userId: currentUser?.user_id, // NEW
});
```

#### 5.2 Claude Agent SDK (Subprocess Spawning)

**Update `packages/core/src/tools/claude/query-builder.ts`**:

When the Claude Agent SDK spawns subprocesses (like `gh`, `npm`, etc.), it reads from `process.env`. We need to **augment `process.env`** before calling the SDK:

```typescript
import { resolveUserEnvironment } from '../../config/env-resolver';

export async function setupQuery(
  sessionId: SessionID,
  prompt: string,
  deps: QuerySetupDeps,
  options: {
    /* ... */
  }
): Promise<QueryResult> {
  // Get session to extract user ID
  const session = await deps.sessionsRepo.get(sessionId);

  // NEW: Resolve and merge user environment into process.env
  if (session.created_by && deps.db) {
    const userEnv = await resolveUserEnvironment(session.created_by, deps.db);

    // Augment process.env with user env vars (temporary for this query)
    const originalEnv = { ...process.env };
    Object.assign(process.env, userEnv);

    try {
      // Call Claude SDK (inherits augmented process.env)
      const result = query({
        prompt,
        options: queryOptions as any,
      });

      return result;
    } finally {
      // Restore original process.env after query completes
      for (const key of Object.keys(userEnv)) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
    }
  }

  // Fallback: No user context, use system env
  return query({
    prompt,
    options: queryOptions as any,
  });
}
```

**⚠️ Important Consideration:**

Augmenting `process.env` is **not ideal** because:

- It's a global mutable state
- Concurrent queries could conflict
- Not thread-safe in principle (though Node.js is single-threaded)

**Decision: Use process.env augmentation approach** (with locking for safety)

- ✅ Works with all SDKs immediately
- ✅ Can optimize later if SDK custom env support is added
- ✅ Locking mechanism prevents race conditions (see Security section below)

#### 5.3 Codex SDK (Subprocess Spawning)

Similar pattern as Claude SDK:

```typescript
// packages/core/src/tools/codex/prompt-service.ts

async prompt(sessionId: SessionID, prompt: string): Promise<void> {
  const session = await this.sessionsRepo.get(sessionId);

  // NEW: Resolve user environment
  if (session.created_by && this.db) {
    const userEnv = await resolveUserEnvironment(session.created_by, this.db);
    const originalEnv = { ...process.env };
    Object.assign(process.env, userEnv);

    try {
      // Codex SDK call (inherits augmented process.env)
      await this.codex.prompt({ /* ... */ });
    } finally {
      // Restore original process.env
      for (const key of Object.keys(userEnv)) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
    }
  } else {
    // Fallback: No user context
    await this.codex.prompt({ /* ... */ });
  }
}
```

#### 5.4 Gemini SDK (Subprocess Spawning)

Same pattern as above. Need to augment `process.env` before Gemini SDK calls.

#### 5.5 Worktree Environment Commands

**Update `packages/core/src/db/repositories/worktrees.ts`** (or wherever env commands are run):

When running `start`/`stop`/`health` commands for worktrees, resolve user env:

```typescript
import { resolveUserEnvironment } from '../../config/env-resolver';
import { execSync } from 'node:child_process';

async function executeWorktreeCommand(
  worktreeId: WorktreeID,
  command: string,
  userId: UserID,
  db: Database
): Promise<string> {
  // Resolve user environment
  const env = await resolveUserEnvironment(userId, db);

  // Execute command with merged environment
  const output = execSync(command, {
    cwd: worktree.path,
    env, // Pass resolved environment
    encoding: 'utf-8',
  });

  return output;
}
```

---

## Security Considerations

### ✅ Security Features

1. **Encryption at Rest**
   - All env vars encrypted with AES-256-GCM (same as API keys)
   - Master secret required (`AGOR_MASTER_SECRET`)
   - Random salt per encryption (no deterministic values)

2. **No Exposure in Responses**
   - User type returns **boolean status** only (keys present, not values)
   - API never returns plaintext env var values
   - Logs should not expose decrypted values

3. **UI Security**
   - Password-masked inputs for values
   - No autocomplete on sensitive fields
   - Clear visual distinction (encrypted tag)

4. **Runtime Isolation**
   - Each user gets their own env vars (no leakage)
   - Terminal sessions inherit user's env (not global)
   - Agent subprocesses get user-specific env

### ⚠️ Security Risks & Mitigations

**Risk 1: Environment Variable Injection**

If a malicious user sets a crafted env var (e.g., `LD_PRELOAD`, `PATH`), they could:

- Hijack subprocess execution
- Load malicious libraries
- Override critical system paths

**Mitigation:**

Add a **blocklist** of dangerous env vars that users cannot set:

```typescript
// packages/core/src/config/env-blocklist.ts
export const BLOCKED_ENV_VARS = new Set([
  'LD_PRELOAD', // Library injection attack vector
  'LD_LIBRARY_PATH', // Library path hijacking
  'DYLD_INSERT_LIBRARIES', // macOS library injection
  'PATH', // Too dangerous to override system PATH
  'SHELL', // Could break terminal
  'HOME', // Could break filesystem operations
  'USER', // Could break user context
  'AGOR_MASTER_SECRET', // Never allow overriding master secret
]);

// In users.ts service
import { BLOCKED_ENV_VARS } from '@agor/core/config/env-blocklist';

if (data.env_vars) {
  for (const [key, value] of Object.entries(data.env_vars)) {
    if (BLOCKED_ENV_VARS.has(key)) {
      throw new Error(`Environment variable "${key}" is blocked for security reasons`);
    }
    // ... rest of encryption logic
  }
}
```

**Decision: Implement this blocklist in MVP**

**Risk 2: process.env Augmentation Conflicts**

If multiple queries run concurrently, they could overwrite each other's env vars.

**Mitigation:**

Use a **lock per user** to serialize env augmentation:

**Decision: Implement locking mechanism in MVP**

```typescript
const userEnvLocks = new Map<UserID, Promise<void>>();

async function withUserEnvironment<T>(
  userId: UserID,
  db: Database,
  fn: () => Promise<T>
): Promise<T> {
  // Wait for any existing lock for this user
  const existingLock = userEnvLocks.get(userId);
  if (existingLock) {
    await existingLock;
  }

  // Create new lock
  let releaseLock: () => void;
  const lock = new Promise<void>(resolve => {
    releaseLock = resolve;
  });
  userEnvLocks.set(userId, lock);

  try {
    // Resolve user env
    const userEnv = await resolveUserEnvironment(userId, db);
    const originalEnv = { ...process.env };

    // Augment process.env
    Object.assign(process.env, userEnv);

    try {
      // Execute function
      return await fn();
    } finally {
      // Restore original env
      for (const key of Object.keys(userEnv)) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
    }
  } finally {
    // Release lock
    releaseLock!();
    userEnvLocks.delete(userId);
  }
}
```

**Risk 3: Logging Sensitive Values**

If env vars are accidentally logged, secrets could leak.

**Mitigation:**

- Never log decrypted env var **values** (only keys)
- Add sanitization to logging utilities
- Document best practices for developers

---

## UI/UX Flow

### User Journey: Setting Environment Variables

1. **Navigate to Settings → Users**
2. **Click "Edit" on a user**
3. **Expand "Environment Variables" collapsed section**
4. **See table of existing env vars** (name + "Set" status)
5. **Click "Add" to add a new variable**:
   - Enter variable name (e.g., `GITHUB_TOKEN`)
   - Enter value (masked password input)
   - Click "Add" button
6. **Variable is encrypted and saved** (shows "Set (encrypted)" tag)
7. **Variable is now available to:**
   - All agent operations (Claude, Codex, Gemini)
   - Terminal sessions
   - Worktree environment commands

### User Journey: Updating Environment Variable

1. **Open user edit modal**
2. **Expand "Environment Variables"**
3. **Click "Update" next to a variable**
4. **Enter new value** (password-masked input)
5. **Click "Save"**
6. **Variable is re-encrypted with new value**

### User Journey: Deleting Environment Variable

1. **Open user edit modal**
2. **Expand "Environment Variables"**
3. **Click "Delete" next to a variable**
4. **Confirm deletion** (optional confirmation modal)
5. **Variable is removed from database**

---

## File Checklist

### New Files to Create (2)

1. ✅ `apps/agor-ui/src/components/EnvVarEditor.tsx` - Reusable env var editor component
2. ✅ `packages/core/src/config/env-resolver.ts` - Environment resolution utility
3. ✅ `context/explorations/user-env-vars.md` - This architecture document

### Files to Edit (6)

1. ✅ `packages/core/src/types/user.ts` - Add `env_vars` field to User/UpdateUserInput
2. ✅ `packages/core/src/db/schema.ts` - Extend users.data type definition
3. ✅ `packages/core/src/config/index.ts` - Export env-resolver
4. ✅ `apps/agor-daemon/src/services/users.ts` - Add env var encryption, getEnvironmentVariables()
5. ✅ `apps/agor-ui/src/components/SettingsModal/UsersTable.tsx` - Add env vars section to edit modal
6. ✅ `apps/agor-daemon/src/services/terminals.ts` - Integrate env resolution in PTY spawning
7. ✅ `packages/core/src/tools/claude/query-builder.ts` - Augment process.env before SDK calls
8. ✅ `packages/core/src/tools/codex/prompt-service.ts` - Augment process.env before SDK calls
9. ✅ `packages/core/src/tools/gemini/prompt-service.ts` - Augment process.env before SDK calls

---

## Implementation Decisions

### ✅ **Decision 1: SDK Environment Variable Injection**

**Approach:** Use `process.env` augmentation with per-user locking

**Rationale:**

- Works with all SDKs immediately (no SDK investigation needed)
- Can optimize later if SDK custom env support is discovered
- Locking mechanism prevents race conditions (see Security section)

**Status:** ✅ Decided - Proceed with implementation

---

### ✅ **Decision 2: Environment Variable Validation**

**Validation Rules (enforced in users service):**

1. **Name format:** `^[A-Z_][A-Z0-9_]*$` (uppercase letters, underscores, numbers only)
2. **Blocklist check:** Must not be in `BLOCKED_ENV_VARS` set
3. **Value constraints:**
   - Must not be empty string
   - Must not exceed 10KB (10,240 bytes)

**Rationale:**

- Uppercase convention is standard for env vars
- Blocklist prevents security vulnerabilities
- Length limit prevents abuse

**Status:** ✅ Decided - Implement in MVP

---

### ✅ **Decision 3: Security Blocklist**

**Blocked Variables:**

```typescript
BLOCKED_ENV_VARS = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'PATH',
  'SHELL',
  'HOME',
  'USER',
  'AGOR_MASTER_SECRET',
];
```

**Status:** ✅ Decided - Implement in MVP

---

### ✅ **Decision 4: Current User Context in Terminal**

**Approach:** Pass authenticated user ID from UI to terminal service

**Implementation:**

- UI retrieves current user from authentication context (already exists for session creation)
- Terminal creation endpoint accepts optional `userId` parameter
- Terminal service uses `userId` to resolve env vars before spawning PTY

**Status:** ✅ Decided - Use existing auth context patterns

---

### ⏭️ **Decision 5: Global Environment Variables**

**Decision:** Defer to v2 (out of scope for MVP)

**Rationale:**

- Per-user env vars solve the immediate use case (GITHUB_TOKEN, NPM_TOKEN)
- Global env vars add complexity (precedence, conflict resolution)
- Can be added later without breaking changes

**Status:** ⏭️ Deferred - Not in MVP scope

---

### ⏭️ **Decision 6: Audit Logging**

**Decision:** Defer to v2 (out of scope for MVP)

**Rationale:**

- Not critical for initial release
- Same as API key audit logging (consistent deferral)
- Can be added later as part of broader audit system

**Status:** ⏭️ Deferred - Not in MVP scope

---

### ⏭️ **Decision 7: Environment Variable Templates**

**Decision:** Defer to v2 (nice-to-have, not critical)

**Rationale:**

- Users can manually enter common vars (GITHUB_TOKEN, NPM_TOKEN, etc.)
- Templates add UI complexity without solving core use case
- Can be added later based on user feedback

**Status:** ⏭️ Deferred - Not in MVP scope

---

## Estimated Effort

| Phase                           | Estimated Time  | Complexity | Priority |
| ------------------------------- | --------------- | ---------- | -------- |
| **Backend Schema & Types**      | 2-3 hours       | Low        | High     |
| **Environment Resolver**        | 3-4 hours       | Medium     | High     |
| **UI Component (EnvVarEditor)** | 4-5 hours       | Medium     | High     |
| **Users Service Update**        | 2-3 hours       | Low        | High     |
| **Terminal Integration**        | 2-3 hours       | Medium     | High     |
| **SDK Integration (3 SDKs)**    | 6-8 hours       | High       | High     |
| **Security (Blocklist, Locks)** | 3-4 hours       | Medium     | High     |
| **Testing & QA**                | 4-6 hours       | Medium     | High     |
| **Documentation**               | 2-3 hours       | Low        | Medium   |
| **Total**                       | **28-39 hours** | **Medium** | -        |

### Breakdown by Sprint

**Sprint 1: Backend Infrastructure (7-10 hours)**

- Extend user schema/types
- Create env-resolver utility
- Update users service with encryption
- Add security blocklist

**Sprint 2: UI Component (4-5 hours)**

- Build EnvVarEditor component
- Integrate into UsersTable modal

**Sprint 3: Integration (8-11 hours)**

- Terminal service (PTY)
- Claude SDK integration
- Codex SDK integration
- Gemini SDK integration

**Sprint 4: Testing & Polish (9-13 hours)**

- Unit tests (encryption, resolution, validation)
- Integration tests (terminal, SDK subprocess calls)
- Security testing (blocklist, injection attacks)
- Documentation

---

## Success Criteria

### Functional Requirements

- [ ] Users can add/update/delete environment variables via UI
- [ ] Environment variables are encrypted at rest (AES-256-GCM)
- [ ] Terminal sessions inherit user env vars
- [ ] Claude SDK subprocesses inherit user env vars
- [ ] Codex SDK subprocesses inherit user env vars
- [ ] Gemini SDK subprocesses inherit user env vars
- [ ] Worktree environment commands use user env vars
- [ ] User env vars override system env vars (correct precedence)
- [ ] Blocked env vars (LD_PRELOAD, PATH, etc.) are rejected
- [ ] UI shows encrypted status (not actual values)

### Non-Functional Requirements

- [ ] Environment resolution < 100ms
- [ ] No performance regression in terminal/subprocess spawning
- [ ] Backwards compatible (works without user env vars)
- [ ] Secure storage (AES-256-GCM encryption)
- [ ] No race conditions (proper locking for process.env)
- [ ] Clear error messages for validation failures

### User Experience

- [ ] Intuitive UI for managing env vars (table view + add form)
- [ ] Password-masked inputs for values
- [ ] Clear documentation of use cases (GITHUB_TOKEN, NPM_TOKEN, etc.)
- [ ] No disruption to existing workflows
- [ ] Terminal sessions automatically pick up env vars (no manual setup)

---

## Rollout Plan

### Phase 1: Internal Testing (Week 1)

- Deploy to staging
- Test with real-world use cases (GitHub CLI, npm private packages)
- Verify security (encryption, blocklist, locking)
- Fix bugs

### Phase 2: Beta Release (Week 2)

- Document setup guide (how to set env vars)
- Announce feature in release notes
- Monitor for issues
- Gather feedback

### Phase 3: General Availability (Week 3+)

- Promote feature in docs
- Update onboarding flow
- Monitor adoption
- Plan future enhancements (global env vars, templates)

---

## Summary

This proposal extends the per-user API key system to support **arbitrary environment variables**, enabling users to configure credentials and settings (like `GITHUB_TOKEN`, `NPM_TOKEN`) that are automatically available to:

✅ **Agentic coding tools** (Claude, Codex, Gemini) when spawning subprocesses
✅ **Terminal sessions** (PTY) created via the Terminal Modal
✅ **Worktree environment commands** (start/stop/health)

**Key Benefits:**

- ✅ Reuses existing encryption infrastructure (AES-256-GCM)
- ✅ Consistent UI patterns (similar to API keys)
- ✅ Secure per-user isolation (no shared secrets)
- ✅ Automatic inheritance (no manual setup per environment)
- ✅ Precedence order: User env vars > System env vars

**Security Features:**

- ✅ Encrypted at rest
- ✅ Never exposed in API responses (boolean status only)
- ✅ Blocklist for dangerous env vars (LD_PRELOAD, PATH, etc.)
- ✅ Locking to prevent race conditions (process.env augmentation)

**Estimated Effort:** 28-39 hours across 4 sprints

---

## Ready for Implementation 🚀

**All decisions finalized:**

- ✅ UI pattern: Accumulator (documented in `design.md`)
- ✅ Security: Blocklist + validation rules
- ✅ Integration: process.env augmentation with locking
- ✅ Scope: MVP features vs v2 deferrals

**Next Steps:**

1. ✅ **Proposal approved** - All decisions documented
2. 🚀 **Begin implementation** - Start with Sprint 1 (Backend Infrastructure)
3. 🧪 **Test with real use cases** - GitHub CLI (`gh`), npm private packages
4. 📖 **Document user guide** - How to set GITHUB_TOKEN, NPM_TOKEN, etc.

**Start coding!** All architectural decisions are in place.
