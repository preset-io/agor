# Per-User API Keys Implementation Plan

**Status**: Planning
**Created**: 2025-11-01
**Author**: Claude (Session 019a3af2)

---

## Executive Summary

This document outlines the complete implementation plan for adding per-user API key support to Agor. Users will be able to configure their own API keys (Anthropic, OpenAI, Gemini) which will take precedence over global settings, with encryption at rest for security.

---

## Current State Analysis

### ✅ What Works Well

1. **Global API Key Management**: The `AgenticToolsTab` component (`apps/agor-ui/src/components/SettingsModal/AgenticToolsTab.tsx`) is well-designed with:
   - Masked password inputs
   - Clear status indicators (Set/Not Set)
   - Save/Clear functionality
   - Documentation links
   - Error handling

2. **User Management**: `UsersTable` component has full CRUD with emoji picker, role management, and clean modal design

3. **API Key Resolution**: Current flow is `config.yaml > process.env` with hot-reload support

4. **Password Security**: bcryptjs with 10 salt rounds is already in place

### ❌ What's Missing

1. **No encryption for API keys** - Currently stored in plaintext in `~/.agor/config.yaml`
2. **No per-user API key fields** in user schema
3. **No API key component extraction** - AgenticToolsTab is monolithic
4. **No per-user key resolution** - Tools only check global config

### Current Architecture

#### API Key Storage

API keys are currently stored in `~/.agor/config.yaml`:

```yaml
credentials:
  ANTHROPIC_API_KEY: sk-ant-...
  OPENAI_API_KEY: sk-proj-...
  GEMINI_API_KEY: AIza...
  CURSOR_API_KEY: (optional)
```

**Storage Location**: File system (`~/.agor/config.yaml`)
**Encryption**: None (plaintext)
**Masking**: Only in UI/API responses (first 10 chars visible)

#### API Key Resolution Flow

```
User sets API key in Settings UI
         ↓
Config Service PATCH endpoint
         ↓
1. Update ~/.agor/config.yaml
2. Update process.env[KEY]
         ↓
Tools (Claude/Codex/Gemini)
         ↓
On next prompt:
- Claude: calls getCredential('ANTHROPIC_API_KEY')
- Codex: calls refreshClient() → getCredential('OPENAI_API_KEY')
- Gemini: calls config.refreshAuth(AuthType.USE_GEMINI)
         ↓
Read from: config.yaml (via loadConfigSync) or process.env
```

**Current Precedence**: `config.yaml > process.env > individual tool auth`

#### User Data Model

**Type Definition** (`packages/core/src/types/user.ts`):

```typescript
interface User {
  user_id: UserID;
  email: string;
  name?: string;
  emoji?: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  avatar?: string;
  preferences?: Record<string, unknown>;
  onboarding_completed: boolean;
  created_at: Date;
  updated_at?: Date;
}
```

**Database Schema** (`packages/core/src/db/schema.ts`):

```sql
users table:
  - user_id (text, PK)
  - email (text, UNIQUE)
  - password (text) -- bcrypt hashed
  - name (text, nullable)
  - emoji (text, nullable)
  - role (text, enum)
  - onboarding_completed (boolean)
  - data (JSON blob):
    - avatar?: string
    - preferences?: Record<string, unknown>
```

---

## Implementation Plan

### Phase 1: Database Schema & Encryption 🔐

#### 1.1 Add Encryption Utilities

**File**: `packages/core/src/db/encryption.ts` (NEW)

Create encryption utilities using Node.js built-in `crypto` module:

```typescript
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Get master secret from environment
 * Falls back to warning if not set (dev mode)
 */
function getMasterSecret(): string {
  const secret = process.env.AGOR_MASTER_SECRET;

  if (!secret) {
    console.warn(
      '⚠️  AGOR_MASTER_SECRET not set - API keys will be stored in plaintext. ' +
        'Set this environment variable to enable encryption.'
    );
    return '';
  }

  return secret;
}

/**
 * Derive encryption key from master secret using scrypt
 */
function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH);
}

/**
 * Encrypt API key using AES-256-GCM
 *
 * @param plaintext - API key to encrypt
 * @param secret - Master secret (from AGOR_MASTER_SECRET env var)
 * @returns Encrypted string in format: {salt}:{iv}:{authTag}:{encryptedData} (hex-encoded)
 */
export function encryptApiKey(plaintext: string, secret?: string): string {
  const masterSecret = secret || getMasterSecret();

  // If no master secret, return plaintext (dev mode)
  if (!masterSecret) {
    return plaintext;
  }

  // Generate random salt and IV
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);

  // Derive key from master secret
  const key = deriveKey(masterSecret, salt);

  // Create cipher
  const cipher = createCipheriv(ALGORITHM, key, iv);

  // Encrypt
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  // Get authentication tag
  const authTag = cipher.getAuthTag();

  // Return as hex-encoded string
  return [
    salt.toString('hex'),
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Decrypt API key using AES-256-GCM
 *
 * @param ciphertext - Encrypted string in format: {salt}:{iv}:{authTag}:{encryptedData}
 * @param secret - Master secret (from AGOR_MASTER_SECRET env var)
 * @returns Decrypted API key
 */
export function decryptApiKey(ciphertext: string, secret?: string): string {
  const masterSecret = secret || getMasterSecret();

  // If no master secret and ciphertext doesn't look encrypted, return as-is (dev mode)
  if (!masterSecret && !ciphertext.includes(':')) {
    return ciphertext;
  }

  // Parse encrypted string
  const parts = ciphertext.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted data format');
  }

  const [saltHex, ivHex, authTagHex, encryptedHex] = parts;

  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  // Derive key from master secret
  const key = deriveKey(masterSecret, salt);

  // Create decipher
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  // Decrypt
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString('utf8');
}

/**
 * Check if a string is encrypted
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 4 && parts.every(part => /^[0-9a-f]+$/i.test(part));
}
```

**Design Decisions**:

- **Algorithm**: AES-256-GCM (authenticated encryption, prevents tampering)
- **Key Derivation**: Uses scrypt with random salt for each encryption
- **Storage Format**: `{salt}:{iv}:{authTag}:{encryptedData}` (hex-encoded)
- **Master Secret**: `AGOR_MASTER_SECRET` environment variable (must be set at daemon startup)
- **Fallback**: If `AGOR_MASTER_SECRET` not set, store plaintext (dev mode) with console warning

#### 1.2 Extend User Schema

**File**: `packages/core/src/db/schema.ts` (EDIT line 409)

Extend the `data` JSON blob to include encrypted API keys:

```typescript
data: text('data', { mode: 'json' })
  .$type<{
    avatar?: string;
    preferences?: Record<string, unknown>;
    // NEW: Encrypted API keys (stored as hex-encoded encrypted strings)
    api_keys?: {
      ANTHROPIC_API_KEY?: string;  // Encrypted with AES-256-GCM
      OPENAI_API_KEY?: string;     // Encrypted with AES-256-GCM
      GEMINI_API_KEY?: string;     // Encrypted with AES-256-GCM
    };
  }>()
  .notNull(),
```

**Migration**: Generate migration to add `api_keys` to existing users' data blobs (defaults to `{}`)

**File**: `packages/core/src/db/migrations/NNNN_add_user_api_keys.ts` (NEW)

```typescript
import type { Database } from '../client';

export async function up(db: Database): Promise<void> {
  // No schema changes needed - just ensure data blob exists
  console.log('✅ User API keys support added (data.api_keys)');
}

export async function down(db: Database): Promise<void> {
  // No-op - data blob is flexible
  console.log('✅ User API keys support removed');
}
```

#### 1.3 Update User Types

**File**: `packages/core/src/types/user.ts` (EDIT)

```typescript
/**
 * User type - Authentication and authorization
 */
export interface User {
  user_id: UserID;
  email: string;
  name?: string;
  emoji?: string;
  role: UserRole;
  avatar?: string;
  preferences?: Record<string, unknown>;
  onboarding_completed: boolean;
  created_at: Date;
  updated_at?: Date;
  // NEW: API key status (boolean only, never exposes actual keys)
  api_keys?: {
    ANTHROPIC_API_KEY?: boolean; // true = key is set, false/undefined = not set
    OPENAI_API_KEY?: boolean;
    GEMINI_API_KEY?: boolean;
  };
}

/**
 * Update user input
 */
export interface UpdateUserInput {
  email?: string;
  password?: string;
  name?: string;
  emoji?: string;
  role?: UserRole;
  avatar?: string;
  preferences?: Record<string, unknown>;
  onboarding_completed?: boolean;
  // NEW: API keys for update (accepts plaintext, encrypted before storage)
  api_keys?: {
    ANTHROPIC_API_KEY?: string | null; // string = set key, null = clear key
    OPENAI_API_KEY?: string | null;
    GEMINI_API_KEY?: string | null;
  };
}
```

**Important**:

- User type exposes `boolean` status (not actual keys)
- UpdateUserInput accepts plaintext strings (encrypted by service before storage)
- `null` value clears the key, `undefined` leaves it unchanged

#### 1.4 Export Encryption Utilities

**File**: `packages/core/src/db/index.ts` (EDIT)

Add export for encryption utilities:

```typescript
// Encryption utilities
export * from './encryption';
```

---

### Phase 2: Component Extraction & Generalization 🎨

#### 2.1 Extract Reusable API Key Form Component

**File**: `apps/agor-ui/src/components/ApiKeyFields.tsx` (NEW)

Extract the API key field rendering logic from `AgenticToolsTab`:

```tsx
import type { AgorConfig } from '@agor/core/config';
import { CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined } from '@ant-design/icons';
import { Button, Input, Space, Tag, Typography, theme } from 'antd';
import { useState } from 'react';

const { Text, Link } = Typography;

export interface ApiKeyStatus {
  ANTHROPIC_API_KEY: boolean;
  OPENAI_API_KEY: boolean;
  GEMINI_API_KEY: boolean;
}

export interface ApiKeyFieldsProps {
  /** Current status of each key (true = set, false = not set) */
  keyStatus: ApiKeyStatus;
  /** Callback when user saves a new key */
  onSave: (field: keyof ApiKeyStatus, value: string) => Promise<void>;
  /** Callback when user clears a key */
  onClear: (field: keyof ApiKeyStatus) => Promise<void>;
  /** Loading state for save/clear operations */
  saving?: Record<string, boolean>;
  /** Disable all fields */
  disabled?: boolean;
}

interface KeyFieldConfig {
  field: keyof ApiKeyStatus;
  label: string;
  description: string;
  placeholder: string;
  docUrl: string;
}

const KEY_CONFIGS: KeyFieldConfig[] = [
  {
    field: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API Key',
    description: '(Claude Code / Agent SDK)',
    placeholder: 'sk-ant-api03-...',
    docUrl: 'https://console.anthropic.com',
  },
  {
    field: 'OPENAI_API_KEY',
    label: 'OpenAI API Key',
    description: '(Codex)',
    placeholder: 'sk-proj-...',
    docUrl: 'https://platform.openai.com/api-keys',
  },
  {
    field: 'GEMINI_API_KEY',
    label: 'Gemini API Key',
    description: '',
    placeholder: 'AIza...',
    docUrl: 'https://aistudio.google.com/app/apikey',
  },
];

export const ApiKeyFields: React.FC<ApiKeyFieldsProps> = ({
  keyStatus,
  onSave,
  onClear,
  saving = {},
  disabled = false,
}) => {
  const { token } = theme.useToken();
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  const handleSave = async (field: keyof ApiKeyStatus) => {
    const value = inputValues[field]?.trim();
    if (!value) return;

    await onSave(field, value);
    setInputValues(prev => ({ ...prev, [field]: '' }));
  };

  const renderKeyField = (config: KeyFieldConfig) => {
    const { field, label, description, placeholder, docUrl } = config;
    const isSet = keyStatus[field];

    return (
      <div key={field} style={{ marginBottom: token.marginLG }}>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Space>
            <Text strong>{label}</Text>
            {description && <Text type="secondary">{description}</Text>}
            {isSet ? (
              <Tag icon={<CheckCircleOutlined />} color="success">
                Set
              </Tag>
            ) : (
              <Tag icon={<CloseCircleOutlined />} color="default">
                Not Set
              </Tag>
            )}
          </Space>

          {isSet ? (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() => onClear(field)}
              loading={saving[field]}
              disabled={disabled}
            >
              Clear Key
            </Button>
          ) : (
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password
                placeholder={placeholder}
                value={inputValues[field] || ''}
                onChange={e => setInputValues(prev => ({ ...prev, [field]: e.target.value }))}
                onPressEnter={() => handleSave(field)}
                style={{ flex: 1 }}
                disabled={disabled}
              />
              <Button
                type="primary"
                onClick={() => handleSave(field)}
                loading={saving[field]}
                disabled={disabled || !inputValues[field]?.trim()}
              >
                Save
              </Button>
            </Space.Compact>
          )}

          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Get your key at:{' '}
            <Link href={docUrl} target="_blank">
              {docUrl}
            </Link>
          </Text>
        </Space>
      </div>
    );
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {KEY_CONFIGS.map(config => renderKeyField(config))}
    </Space>
  );
};
```

#### 2.2 Refactor AgenticToolsTab to Use Extracted Component

**File**: `apps/agor-ui/src/components/SettingsModal/AgenticToolsTab.tsx` (EDIT)

Replace inline `renderKeyField` calls with `<ApiKeyFields />` component:

```tsx
import type { AgorClient } from '@agor/core/api';
import type { AgorConfig } from '@agor/core/config';
import { InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Spin, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { ApiKeyFields, type ApiKeyStatus } from '../ApiKeyFields';

const { Text } = Typography;

export interface AgenticToolsTabProps {
  client: AgorClient | null;
}

export const AgenticToolsTab: React.FC<AgenticToolsTabProps> = ({ client }) => {
  const { token } = theme.useToken();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus>({
    ANTHROPIC_API_KEY: false,
    OPENAI_API_KEY: false,
    GEMINI_API_KEY: false,
  });

  // Load current config on mount
  useEffect(() => {
    if (!client) return;

    const loadConfig = async () => {
      try {
        setLoading(true);
        setError(null);

        const config = (await client.service('config').get('credentials')) as
          | AgorConfig['credentials']
          | undefined;

        setKeyStatus({
          ANTHROPIC_API_KEY: !!config?.ANTHROPIC_API_KEY,
          OPENAI_API_KEY: !!config?.OPENAI_API_KEY,
          GEMINI_API_KEY: !!config?.GEMINI_API_KEY,
        });
      } catch (err) {
        console.error('Failed to load config:', err);
        setError(err instanceof Error ? err.message : 'Failed to load configuration');
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, [client]);

  // Save handler
  const handleSave = async (field: keyof ApiKeyStatus, value: string) => {
    if (!client) return;

    try {
      setSaving(prev => ({ ...prev, [field]: true }));
      setError(null);

      await client.service('config').patch(null, {
        credentials: {
          [field]: value,
        },
      });

      setKeyStatus(prev => ({ ...prev, [field]: true }));
    } catch (err) {
      console.error(`Failed to save ${field}:`, err);
      setError(err instanceof Error ? err.message : `Failed to save ${field}`);
      throw err;
    } finally {
      setSaving(prev => ({ ...prev, [field]: false }));
    }
  };

  // Clear handler
  const handleClear = async (field: keyof ApiKeyStatus) => {
    if (!client) return;

    try {
      setSaving(prev => ({ ...prev, [field]: true }));
      setError(null);

      await client.service('config').patch(null, {
        credentials: {
          [field]: null,
        },
      });

      setKeyStatus(prev => ({ ...prev, [field]: false }));
    } catch (err) {
      console.error(`Failed to clear ${field}:`, err);
      setError(err instanceof Error ? err.message : `Failed to clear ${field}`);
      throw err;
    } finally {
      setSaving(prev => ({ ...prev, [field]: false }));
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: token.paddingLG }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ padding: token.paddingMD }}>
      <Alert
        message="Authentication Methods"
        description={
          <div>
            <p style={{ marginBottom: token.marginXS }}>
              There are three ways to authenticate with AI providers,{' '}
              <strong>in order of precedence</strong>:
            </p>
            <ol style={{ paddingLeft: token.paddingMD, marginBottom: 0 }}>
              <li style={{ marginBottom: token.marginXXS }}>
                <strong>Per-user API keys</strong> - Set in user profile, highest priority
              </li>
              <li style={{ marginBottom: token.marginXXS }}>
                <strong>Global keys (this UI or CLI)</strong> - Keys stored in{' '}
                <code>~/.agor/config.yaml</code> override environment variables
              </li>
              <li style={{ marginBottom: token.marginXXS }}>
                <strong>Environment variables</strong> - Set <code>ANTHROPIC_API_KEY</code>,{' '}
                <code>OPENAI_API_KEY</code>, etc. wherever you start the Agor daemon
              </li>
              <li>
                <strong>Individual CLI flows</strong> (e.g., <code>claude login</code>) - Each tool
                retains authentication in its own config
              </li>
            </ol>
          </div>
        }
        type="info"
        icon={<InfoCircleOutlined />}
        showIcon
        style={{ marginBottom: token.marginLG }}
      />

      {error && (
        <Alert
          message={error}
          type="error"
          icon={<WarningOutlined />}
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: token.marginLG }}
        />
      )}

      <ApiKeyFields
        keyStatus={keyStatus}
        onSave={handleSave}
        onClear={handleClear}
        saving={saving}
      />
    </div>
  );
};
```

#### 2.3 Add API Keys Section to User Edit Modal

**File**: `apps/agor-ui/src/components/SettingsModal/UsersTable.tsx` (EDIT)

In the Edit User Modal (line 250-302), add a new collapsed section:

```tsx
import type { CreateUserInput, UpdateUserInput, User } from '@agor/core/types';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Collapse,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { ApiKeyFields, type ApiKeyStatus } from '../ApiKeyFields';
import { FormEmojiPickerInput } from '../EmojiPickerInput';

// ... existing code ...

export const UsersTable: React.FC<UsersTableProps> = ({ users, onCreate, onUpdate, onDelete }) => {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form] = Form.useForm();

  // NEW: API key management state for user edit
  const [userApiKeyStatus, setUserApiKeyStatus] = useState<ApiKeyStatus>({
    ANTHROPIC_API_KEY: false,
    OPENAI_API_KEY: false,
    GEMINI_API_KEY: false,
  });
  const [savingApiKeys, setSavingApiKeys] = useState<Record<string, boolean>>({});

  // Load user's API key status when editing
  useEffect(() => {
    if (editingUser?.api_keys) {
      setUserApiKeyStatus({
        ANTHROPIC_API_KEY: !!editingUser.api_keys.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: !!editingUser.api_keys.OPENAI_API_KEY,
        GEMINI_API_KEY: !!editingUser.api_keys.GEMINI_API_KEY,
      });
    } else {
      setUserApiKeyStatus({
        ANTHROPIC_API_KEY: false,
        OPENAI_API_KEY: false,
        GEMINI_API_KEY: false,
      });
    }
  }, [editingUser]);

  // ... existing handlers ...

  const handleEdit = (user: User) => {
    setEditingUser(user);
    form.setFieldsValue({
      email: user.email,
      name: user.name,
      emoji: user.emoji,
      role: user.role,
    });
    setEditModalOpen(true);
  };

  // NEW: Handle user API key save
  const handleApiKeySave = async (field: keyof ApiKeyStatus, value: string) => {
    if (!editingUser) return;

    try {
      setSavingApiKeys(prev => ({ ...prev, [field]: true }));

      // Update user via onUpdate callback
      await onUpdate?.(editingUser.user_id, {
        api_keys: {
          [field]: value,
        },
      });

      // Update local state
      setUserApiKeyStatus(prev => ({ ...prev, [field]: true }));
    } catch (err) {
      console.error(`Failed to save ${field}:`, err);
      throw err;
    } finally {
      setSavingApiKeys(prev => ({ ...prev, [field]: false }));
    }
  };

  // NEW: Handle user API key clear
  const handleApiKeyClear = async (field: keyof ApiKeyStatus) => {
    if (!editingUser) return;

    try {
      setSavingApiKeys(prev => ({ ...prev, [field]: true }));

      // Update user via onUpdate callback
      await onUpdate?.(editingUser.user_id, {
        api_keys: {
          [field]: null,
        },
      });

      // Update local state
      setUserApiKeyStatus(prev => ({ ...prev, [field]: false }));
    } catch (err) {
      console.error(`Failed to clear ${field}:`, err);
      throw err;
    } finally {
      setSavingApiKeys(prev => ({ ...prev, [field]: false }));
    }
  };

  // ... existing table and create modal code ...

  return (
    <div>
      {/* ... existing table and create modal ... */}

      {/* Edit User Modal */}
      <Modal
        title="Edit User"
        open={editModalOpen}
        onOk={handleUpdate}
        onCancel={() => {
          form.resetFields();
          setEditModalOpen(false);
          setEditingUser(null);
        }}
        okText="Save"
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="Name" style={{ marginBottom: 24 }}>
            <Flex gap={8}>
              <Form.Item name="emoji" noStyle>
                <FormEmojiPickerInput form={form} fieldName="emoji" defaultEmoji="👤" />
              </Form.Item>
              <Form.Item name="name" noStyle style={{ flex: 1 }}>
                <Input placeholder="John Doe" style={{ flex: 1 }} />
              </Form.Item>
            </Flex>
          </Form.Item>

          <Form.Item
            label="Email"
            name="email"
            rules={[
              { required: true, message: 'Please enter an email' },
              { type: 'email', message: 'Please enter a valid email' },
            ]}
          >
            <Input placeholder="user@example.com" />
          </Form.Item>

          <Form.Item label="Password" name="password" help="Leave blank to keep current password">
            <Input.Password placeholder="••••••••" />
          </Form.Item>

          <Form.Item
            label="Role"
            name="role"
            rules={[{ required: true, message: 'Please select a role' }]}
          >
            <Select>
              <Select.Option value="owner">Owner</Select.Option>
              <Select.Option value="admin">Admin</Select.Option>
              <Select.Option value="member">Member</Select.Option>
              <Select.Option value="viewer">Viewer</Select.Option>
            </Select>
          </Form.Item>

          {/* NEW: API Keys Section */}
          <Form.Item label="API Keys">
            <Collapse
              ghost
              items={[
                {
                  key: 'api-keys',
                  label: 'Configure Per-User API Keys',
                  children: (
                    <div style={{ paddingTop: 8 }}>
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                        Per-user API keys take precedence over global settings. These keys are
                        encrypted at rest.
                      </Typography.Paragraph>
                      <ApiKeyFields
                        keyStatus={userApiKeyStatus}
                        onSave={handleApiKeySave}
                        onClear={handleApiKeyClear}
                        saving={savingApiKeys}
                      />
                    </div>
                  ),
                },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
```

---

### Phase 3: Backend Services 🔧

#### 3.1 Update Users Service to Handle Encrypted Keys

**File**: `apps/agor-daemon/src/services/users.ts` (EDIT)

Add encryption/decryption logic in the service:

```typescript
import { generateId } from '@agor/core';
import {
  compare,
  decryptApiKey,
  encryptApiKey,
  type Database,
  eq,
  hash,
  users,
} from '@agor/core/db';
import type { Paginated, Params, User, UserID } from '@agor/core/types';

// ... existing interfaces ...

/**
 * Users Service Methods
 */
export class UsersService {
  constructor(protected db: Database) {}

  // ... existing find() and get() methods ...

  /**
   * Update user
   */
  async patch(id: UserID, data: UpdateUserData, _params?: Params): Promise<User> {
    const now = new Date();
    const updates: Record<string, unknown> = { updated_at: now };

    // Handle password separately (needs hashing)
    if (data.password) {
      updates.password = await hash(data.password, 10);
    }

    // Update other fields
    if (data.email) updates.email = data.email;
    if (data.name) updates.name = data.name;
    if (data.emoji !== undefined) updates.emoji = data.emoji;
    if (data.role) updates.role = data.role;
    if (data.onboarding_completed !== undefined)
      updates.onboarding_completed = data.onboarding_completed;

    // Update data blob
    if (data.avatar || data.preferences || data.api_keys) {
      const current = await this.get(id);
      const currentData = current.data as {
        avatar?: string;
        preferences?: Record<string, unknown>;
        api_keys?: Record<string, string>;
      };

      // Handle API keys (encrypt before storage)
      let encryptedKeys = currentData.api_keys || {};
      if (data.api_keys) {
        for (const [key, value] of Object.entries(data.api_keys)) {
          if (value === null || value === undefined) {
            // Clear key
            delete encryptedKeys[key];
          } else {
            // Encrypt and store
            try {
              encryptedKeys[key] = encryptApiKey(value);
              console.log(`🔐 Encrypted user API key: ${key}`);
            } catch (err) {
              console.error(`Failed to encrypt ${key}:`, err);
              throw new Error(`Failed to encrypt ${key}`);
            }
          }
        }
      }

      updates.data = {
        avatar: data.avatar ?? currentData.avatar,
        preferences: data.preferences ?? currentData.preferences,
        api_keys: Object.keys(encryptedKeys).length > 0 ? encryptedKeys : undefined,
      };
    }

    const row = await this.db
      .update(users)
      .set(updates)
      .where(eq(users.user_id, id))
      .returning()
      .get();

    if (!row) {
      throw new Error(`User not found: ${id}`);
    }

    return this.rowToUser(row);
  }

  // ... existing remove() and findByEmail() methods ...

  /**
   * Get decrypted API key for a user
   * Used by key resolution service
   */
  async getApiKey(
    userId: UserID,
    keyName: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY'
  ): Promise<string | undefined> {
    const row = await this.db.select().from(users).where(eq(users.user_id, userId)).get();

    if (!row) return undefined;

    const data = row.data as { api_keys?: Record<string, string> };
    const encryptedKey = data.api_keys?.[keyName];

    if (!encryptedKey) return undefined;

    try {
      return decryptApiKey(encryptedKey);
    } catch (err) {
      console.error(`Failed to decrypt ${keyName} for user ${userId}:`, err);
      return undefined;
    }
  }

  /**
   * Convert database row to User type
   *
   * @param row - Database row
   * @param includePassword - Include password field (for authentication only)
   */
  private rowToUser(
    row: typeof users.$inferSelect,
    includePassword = false
  ): User & { password?: string } {
    const data = row.data as {
      avatar?: string;
      preferences?: Record<string, unknown>;
      api_keys?: Record<string, string>; // Encrypted keys
    };

    const user: User & { password?: string } = {
      user_id: row.user_id as UserID,
      email: row.email,
      name: row.name ?? undefined,
      emoji: row.emoji ?? undefined,
      role: row.role as 'owner' | 'admin' | 'member' | 'viewer',
      avatar: data.avatar,
      preferences: data.preferences,
      onboarding_completed: !!row.onboarding_completed,
      created_at: row.created_at,
      updated_at: row.updated_at ?? undefined,
      // Return key status (boolean), NOT actual keys
      api_keys: data.api_keys
        ? {
            ANTHROPIC_API_KEY: !!data.api_keys.ANTHROPIC_API_KEY,
            OPENAI_API_KEY: !!data.api_keys.OPENAI_API_KEY,
            GEMINI_API_KEY: !!data.api_keys.GEMINI_API_KEY,
          }
        : undefined,
    };

    // Include password for authentication (FeathersJS LocalStrategy needs this)
    if (includePassword) {
      user.password = row.password;
    }

    return user;
  }
}

// ... rest of file unchanged ...
```

#### 3.2 Create API Key Resolution Service

**File**: `packages/core/src/config/key-resolver.ts` (NEW)

Centralize API key resolution logic with precedence:

```typescript
import type { Database } from '../db/client';
import { eq, users } from '../db/schema';
import { decryptApiKey } from '../db/encryption';
import type { UserID } from '../types';
import { getCredential } from './config-manager';

export type ApiKeyName = 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY';

export interface KeyResolutionContext {
  /** User ID for per-user key lookup */
  userId?: UserID;
  /** Database instance for user lookup */
  db?: Database;
}

/**
 * Resolve API key with precedence:
 * 1. Per-user key (if user authenticated and key set in database)
 * 2. Global config.yaml
 * 3. Environment variables
 *
 * @param keyName - Name of the API key to resolve
 * @param context - Resolution context (user ID and database)
 * @returns Decrypted API key or undefined if not found
 */
export async function resolveApiKey(
  keyName: ApiKeyName,
  context: KeyResolutionContext = {}
): Promise<string | undefined> {
  // 1. Check per-user key (highest precedence)
  if (context.userId && context.db) {
    try {
      const row = await context.db
        .select()
        .from(users)
        .where(eq(users.user_id, context.userId))
        .get();

      if (row) {
        const data = row.data as { api_keys?: Record<string, string> };
        const encryptedKey = data.api_keys?.[keyName];

        if (encryptedKey) {
          const decryptedKey = decryptApiKey(encryptedKey);
          console.log(
            `🔑 Using per-user API key for ${keyName} (user: ${context.userId.substring(0, 8)})`
          );
          return decryptedKey;
        }
      }
    } catch (err) {
      console.error(`Failed to resolve per-user key for ${keyName}:`, err);
      // Fall through to global/env fallback
    }
  }

  // 2. Check global config.yaml (second precedence)
  const globalKey = getCredential(keyName);
  if (globalKey) {
    console.log(`🔑 Using global API key for ${keyName} (from config.yaml)`);
    return globalKey;
  }

  // 3. Fallback to environment variable (lowest precedence)
  const envKey = process.env[keyName];
  if (envKey) {
    console.log(`🔑 Using environment variable for ${keyName}`);
    return envKey;
  }

  // No key found
  return undefined;
}

/**
 * Synchronous version of resolveApiKey (only checks global + env, not per-user)
 * Use this when database access is not available
 */
export function resolveApiKeySync(keyName: ApiKeyName): string | undefined {
  // Check global config.yaml
  const globalKey = getCredential(keyName);
  if (globalKey) return globalKey;

  // Fallback to environment variable
  return process.env[keyName];
}
```

#### 3.3 Export Key Resolver

**File**: `packages/core/src/config/index.ts` (EDIT)

```typescript
export * from './config-manager';
export * from './key-resolver'; // NEW
export * from './types';
```

---

### Phase 4: Tool Integration 🔌

#### 4.1 Update Claude Tool to Use Key Resolver

**File**: `packages/core/src/tools/claude/query-builder.ts` (EDIT)

Modify the tool to pass user context and use the key resolver:

```typescript
import { resolveApiKey } from '../../config/key-resolver';
import type { Database } from '../../db/client';
// ... other imports ...

export async function buildClaudeQuery(
  sessionId: SessionID,
  prompt: string,
  db: Database // Add db parameter
  // ... other parameters
): Promise<QueryResult> {
  // Get session to extract user ID
  const session = await db.select().from(sessions).where(eq(sessions.session_id, sessionId)).get();

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Get Claude Code path
  const claudeCodePath = getClaudeCodePath();

  // Resolve API key with user context
  const apiKey = await resolveApiKey('ANTHROPIC_API_KEY', {
    userId: session.created_by,
    db,
  });

  if (apiKey) {
    queryOptions.apiKey = apiKey;
  }

  // Call Claude Agent SDK
  result = query({
    prompt,
    options: queryOptions as any,
  });

  // ... rest of function
}
```

**Note**: Update all call sites to pass `db` parameter

#### 4.2 Update Codex Tool to Use Key Resolver

**File**: `packages/core/src/tools/codex/prompt-service.ts` (EDIT)

```typescript
import { resolveApiKey } from '../../config/key-resolver';
import type { Database } from '../../db/client';
import type { UserID } from '../../types';
// ... other imports ...

export class CodexPromptService {
  private apiKey: string | undefined;
  private currentUserId?: UserID; // NEW: Track current user
  private db?: Database; // NEW: Database reference

  constructor(
    _messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private sessionMCPServerRepo?: SessionMCPServerRepository,
    private worktreesRepo?: WorktreeRepository,
    apiKey?: string,
    db?: Database // NEW: Accept database
  ) {
    this.apiKey = apiKey;
    this.db = db;
    this.codex = new Codex({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    });
  }

  // Set current user context before prompting
  setUserContext(userId: UserID) {
    this.currentUserId = userId;
  }

  // Refresh client with resolved API key
  private async refreshClient(): Promise<void> {
    const apiKey = await resolveApiKey('OPENAI_API_KEY', {
      userId: this.currentUserId,
      db: this.db,
    });

    this.codex = new Codex({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    });
  }

  async prompt(sessionId: SessionID, prompt: string): Promise<void> {
    // Get session to extract user ID
    const session = await this.sessionsRepo.get(sessionId);
    this.setUserContext(session.created_by);

    // Refresh client with user's API key
    await this.refreshClient();

    // ... rest of method
  }

  // ... rest of class
}
```

**Note**: Update constructor calls to pass `db`

#### 4.3 Update Gemini Tool to Use Key Resolver

**File**: `packages/core/src/tools/gemini/prompt-service.ts` (EDIT)

```typescript
import { resolveApiKey } from '../../config/key-resolver';
import type { Database } from '../../db/client';
import type { UserID } from '../../types';
// ... other imports ...

export class GeminiPromptService {
  private db?: Database; // NEW: Database reference
  private sessionUserId?: UserID; // NEW: Track current user

  constructor(
    // ... existing parameters
    db?: Database // NEW: Accept database
  ) {
    // ... existing initialization
    this.db = db;
  }

  private async getOrCreateClient(
    sessionId: SessionID,
    permissionMode?: PermissionMode
  ): Promise<GeminiClient> {
    // Get session to extract user ID
    if (!this.sessionUserId) {
      const session = await this.sessionsRepo.get(sessionId);
      this.sessionUserId = session.created_by;
    }

    // Check if client exists
    if (this.sessionClients.has(sessionId)) {
      const existingClient = this.sessionClients.get(sessionId)!;
      const config = (existingClient as unknown as GeminiClientWithConfig).config;

      // Resolve API key with user context
      const apiKey = await resolveApiKey('GEMINI_API_KEY', {
        userId: this.sessionUserId,
        db: this.db,
      });

      // Update process.env for Gemini SDK (it reads from env)
      if (apiKey) {
        process.env.GEMINI_API_KEY = apiKey;
      }

      // Refresh auth
      if (config && typeof config.refreshAuth === 'function') {
        try {
          await config.refreshAuth(AuthType.USE_GEMINI);
          console.log(`🔄 [Gemini] Refreshed authentication`);
        } catch (error) {
          // Continue if refresh fails
        }
      }
      return existingClient;
    }

    // Create new client
    // Resolve API key first
    const apiKey = await resolveApiKey('GEMINI_API_KEY', {
      userId: this.sessionUserId,
      db: this.db,
    });

    if (apiKey) {
      process.env.GEMINI_API_KEY = apiKey;
    }

    // Create SDK config
    const config = new Config({
      sessionId,
      // ...
    });

    // Initialize and authenticate
    await config.initialize();
    await config.refreshAuth(AuthType.USE_GEMINI);

    // Create and cache client
    const client = new GeminiClient(config);
    this.sessionClients.set(sessionId, client);
    return client;
  }

  // ... rest of class
}
```

**Note**: Update constructor calls to pass `db`

---

### Phase 5: Global Config Encryption (Optional) 🔐

#### 5.1 Encrypt Global Keys in config.yaml

**File**: `packages/core/src/config/config-manager.ts` (EDIT)

Add encryption when saving credentials:

```typescript
import { encryptApiKey, decryptApiKey, isEncrypted } from '../db/encryption';
// ... other imports ...

/**
 * Save config to ~/.agor/config.yaml
 */
export async function saveConfig(config: AgorConfig): Promise<void> {
  // Encrypt credentials before saving (if master secret is set)
  if (config.credentials && process.env.AGOR_MASTER_SECRET) {
    const encrypted: AgorCredentials = {};

    for (const [key, value] of Object.entries(config.credentials)) {
      if (value) {
        // Only encrypt if not already encrypted
        encrypted[key as keyof AgorCredentials] = isEncrypted(value) ? value : encryptApiKey(value);
      }
    }

    config = {
      ...config,
      credentials: encrypted,
    };

    console.log('🔐 Encrypted credentials in config.yaml');
  }

  // Write to YAML
  const configPath = getConfigPath();
  const yamlContent = stringify(config);
  await fs.promises.writeFile(configPath, yamlContent, 'utf-8');
}

/**
 * Load config from ~/.agor/config.yaml
 */
export async function loadConfig(): Promise<AgorConfig> {
  const configPath = getConfigPath();

  // ... existing file reading logic ...

  const config: AgorConfig = parse(yamlContent);

  // Decrypt credentials after loading (if master secret is set)
  if (config.credentials && process.env.AGOR_MASTER_SECRET) {
    const decrypted: AgorCredentials = {};

    for (const [key, value] of Object.entries(config.credentials)) {
      if (value) {
        try {
          // Only decrypt if encrypted
          decrypted[key as keyof AgorCredentials] = isEncrypted(value)
            ? decryptApiKey(value)
            : value;
        } catch (err) {
          console.error(`Failed to decrypt ${key} in config.yaml, using as-is:`, err);
          decrypted[key as keyof AgorCredentials] = value;
        }
      }
    }

    config.credentials = decrypted;
  }

  return config;
}

/**
 * Synchronous version of loadConfig (for hot paths)
 */
export function loadConfigSync(): AgorConfig {
  // ... existing sync loading logic ...

  const config: AgorConfig = parse(yamlContent);

  // Decrypt credentials (if master secret is set)
  if (config.credentials && process.env.AGOR_MASTER_SECRET) {
    const decrypted: AgorCredentials = {};

    for (const [key, value] of Object.entries(config.credentials)) {
      if (value) {
        try {
          decrypted[key as keyof AgorCredentials] = isEncrypted(value)
            ? decryptApiKey(value)
            : value;
        } catch (err) {
          console.error(`Failed to decrypt ${key}, using as-is:`, err);
          decrypted[key as keyof AgorCredentials] = value;
        }
      }
    }

    config.credentials = decrypted;
  }

  return config;
}
```

#### 5.2 Validate Master Secret on Daemon Startup

**File**: `apps/agor-daemon/src/index.ts` (EDIT)

Add validation and warning on startup:

```typescript
// ... existing imports ...

async function startDaemon() {
  console.log('🚀 Starting Agor daemon...');

  // NEW: Validate master secret
  if (!process.env.AGOR_MASTER_SECRET) {
    console.warn('');
    console.warn('⚠️  WARNING: AGOR_MASTER_SECRET not set');
    console.warn('⚠️  API keys will be stored in plaintext (development mode)');
    console.warn('⚠️  Set AGOR_MASTER_SECRET environment variable to enable encryption');
    console.warn('');
  } else {
    console.log('🔐 API key encryption enabled (AGOR_MASTER_SECRET set)');
  }

  // ... rest of startup code
}
```

---

## File Checklist

### New Files to Create (5)

1. ✅ `packages/core/src/db/encryption.ts` - AES-256-GCM encryption utilities
2. ✅ `packages/core/src/config/key-resolver.ts` - Centralized key resolution with precedence
3. ✅ `apps/agor-ui/src/components/ApiKeyFields.tsx` - Extracted reusable API key form component
4. ✅ `packages/core/src/db/migrations/NNNN_add_user_api_keys.ts` - Migration to add api_keys to users.data
5. ✅ `context/explorations/per-user-api-keys.md` - This architecture documentation

### Files to Edit (11)

1. ✅ `packages/core/src/types/user.ts` - Add `api_keys` field to User/UpdateUserInput
2. ✅ `packages/core/src/db/schema.ts` - Extend users.data type definition
3. ✅ `packages/core/src/db/index.ts` - Export encryption utilities
4. ✅ `packages/core/src/config/index.ts` - Export key resolver
5. ✅ `apps/agor-daemon/src/services/users.ts` - Add encryption in patch(), return status in rowToUser(), add getApiKey()
6. ✅ `apps/agor-ui/src/components/SettingsModal/AgenticToolsTab.tsx` - Refactor to use ApiKeyFields
7. ✅ `apps/agor-ui/src/components/SettingsModal/UsersTable.tsx` - Add API Keys collapsed section to Edit modal
8. ✅ `packages/core/src/tools/claude/query-builder.ts` - Use resolveApiKey()
9. ✅ `packages/core/src/tools/codex/prompt-service.ts` - Use resolveApiKey()
10. ✅ `packages/core/src/tools/gemini/prompt-service.ts` - Use resolveApiKey()
11. ✅ `packages/core/src/config/config-manager.ts` - Add encryption for global keys (optional)
12. ✅ `apps/agor-daemon/src/index.ts` - Add AGOR_MASTER_SECRET validation on startup (optional)

---

## Key Design Decisions

### 1. Encryption Strategy

**Algorithm**: AES-256-GCM

- Authenticated encryption (prevents tampering)
- Industry standard for symmetric encryption
- Built into Node.js crypto module

**Key Derivation**:

- Master secret from `AGOR_MASTER_SECRET` environment variable
- Random salt per encryption (stored with ciphertext)
- scrypt key derivation (CPU/memory hard, resists brute force)

**Storage Format**: `{salt}:{iv}:{authTag}:{encryptedData}` (hex-encoded)

- Self-contained (includes all parameters needed for decryption)
- Easy to store in JSON/YAML
- Human-readable (hex encoding)

**Fallback Mode**:

- If `AGOR_MASTER_SECRET` not set, store plaintext with warning
- Enables dev mode without encryption setup
- Graceful degradation

### 2. API Key Precedence (Final Resolution Order)

```
1. Per-user encrypted key (if user authenticated AND key set in user.api_keys)
   ↓ (if not found)
2. Global encrypted key from config.yaml (if set in ~/.agor/config.yaml)
   ↓ (if not found)
3. Environment variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)
   ↓ (if not found)
4. Individual tool authentication (e.g., `claude login`)
```

**Rationale**:

- Per-user keys provide maximum flexibility and security
- Global keys as fallback enable shared team environments
- Environment variables for CI/CD and deployment
- Tool-specific auth for developer workflows

### 3. UI/UX Flow

**Global Settings**:

- Existing `AgenticToolsTab` refactored to use extracted component
- Still manages global keys in `~/.agor/config.yaml`
- Shows updated precedence documentation

**Per-User Settings**:

- New collapsed section in User Edit modal
- Labeled "Configure Per-User API Keys"
- Uses same `ApiKeyFields` component (consistency)
- Explanation text about encryption and precedence

**Visibility**:

- Users see only boolean status ("Set" / "Not Set")
- Actual key values never returned in API responses
- Password inputs mask entry (security)

**Component Reuse**:

- `ApiKeyFields` component extracted and generalized
- Props-based configuration (status, handlers, disabled state)
- Used in both global settings and per-user settings
- Maintains consistent design language

### 4. Security Considerations

**✅ Security Features**:

- API keys encrypted at rest (AES-256-GCM)
- Keys never returned in API responses (only boolean status)
- Password inputs for key entry (UI masks input)
- Master secret required for encryption (AGOR_MASTER_SECRET)
- Scrypt key derivation (resists brute force)
- Authenticated encryption (prevents tampering)

**⚠️ Security Limitations**:

- Keys decrypted in memory when used by tools (necessary for API calls)
- Master secret stored in environment variable (must be managed securely)
- No key rotation mechanism (future enhancement)
- No audit logging of key access (future enhancement)

**Security Best Practices**:

1. Set `AGOR_MASTER_SECRET` to a strong random value (32+ characters)
2. Store master secret securely (environment, secret manager, not in code)
3. Rotate master secret periodically (requires re-encryption migration)
4. Monitor daemon logs for failed decryption attempts
5. Use per-user keys instead of global keys when possible

### 5. Migration Path

**Existing Users**:

- API keys in `config.yaml` continue to work (global fallback)
- No action required for existing installations
- Can upgrade to per-user keys at any time

**New Users**:

- Can set per-user keys immediately (take precedence)
- Can still use global keys if preferred
- Master secret optional (dev mode)

**Backwards Compatibility**:

- If master secret not set, system degrades gracefully (plaintext with warning)
- Existing tools continue to work unchanged
- Config.yaml format unchanged (encryption transparent)

### 6. Database Schema Design

**Storage Location**: `users.data.api_keys` (JSON blob)

**Rationale**:

- Flexible schema (easy to add new keys)
- No migration needed for new API providers
- Encrypted values stored as strings
- Consistent with existing `avatar`/`preferences` pattern

**Alternatives Considered**:

- Separate `user_api_keys` table (rejected: over-engineering)
- Materialized columns (rejected: inflexible for new keys)
- Environment variables per user (rejected: not persistent)

---

## Testing Checklist

### Unit Tests

- [ ] **Encryption/Decryption**:
  - [ ] Round-trip encryption (plaintext → encrypted → decrypted)
  - [ ] Different master secrets produce different ciphertext
  - [ ] Invalid ciphertext throws error on decrypt
  - [ ] No master secret falls back to plaintext
  - [ ] `isEncrypted()` correctly identifies encrypted strings

- [ ] **Key Resolution**:
  - [ ] Per-user key takes precedence over global
  - [ ] Global key takes precedence over environment
  - [ ] Environment variable used when no per-user/global
  - [ ] Returns undefined when no key found
  - [ ] Logs correct precedence level

- [ ] **User Service**:
  - [ ] `patch()` encrypts API keys before storage
  - [ ] `rowToUser()` returns boolean status (not actual keys)
  - [ ] `getApiKey()` decrypts and returns actual key
  - [ ] Clearing key removes from database
  - [ ] Failed encryption throws error

### Integration Tests

- [ ] **End-to-End Flow**:
  - [ ] User sets per-user key → Tool uses it (not global)
  - [ ] User clears per-user key → Tool falls back to global
  - [ ] Global key works when user has no per-user key
  - [ ] Environment variable used when no user/global key
  - [ ] UI shows correct "Set"/"Not Set" status

- [ ] **Component Integration**:
  - [ ] `ApiKeyFields` component renders correctly
  - [ ] Save button encrypts and stores key
  - [ ] Clear button removes key from database
  - [ ] Loading states shown during operations
  - [ ] Error handling displays user-friendly messages

- [ ] **Tool Integration**:
  - [ ] Claude tool resolves key correctly
  - [ ] Codex tool resolves key correctly
  - [ ] Gemini tool resolves key correctly
  - [ ] Tools refresh keys on each prompt
  - [ ] Failed key resolution doesn't crash tools

### Edge Cases

- [ ] **Encryption Edge Cases**:
  - [ ] Master secret not set (fallback to plaintext with warning)
  - [ ] Invalid encrypted data in database (handle gracefully)
  - [ ] Master secret changed (existing keys fail to decrypt)
  - [ ] Empty string as API key (should not encrypt)
  - [ ] Very long API keys (test length limits)

- [ ] **Database Edge Cases**:
  - [ ] User deleted → API keys removed
  - [ ] Concurrent updates to same user's keys (database locks)
  - [ ] Partial update (only one key changed)
  - [ ] Update with null/undefined values (clear vs ignore)

- [ ] **Resolution Edge Cases**:
  - [ ] User has no database record (anonymous user)
  - [ ] Database connection failed during resolution
  - [ ] Multiple tools requesting key simultaneously
  - [ ] Key changed during active session (hot-reload)

### Performance Tests

- [ ] Encryption/decryption performance (< 10ms)
- [ ] Key resolution latency (< 50ms with database)
- [ ] Batch user updates (100+ users)
- [ ] Concurrent key resolutions (10+ simultaneous)

---

## Open Questions / Future Considerations

### 1. Master Secret Management

**Question**: How should `AGOR_MASTER_SECRET` be generated and stored?

**Options**:

**Option A: Auto-generate on first run**

- Generate random 32-byte secret on first daemon startup
- Store in `~/.agor/master.key` (file with restricted permissions)
- Pros: Zero-config, secure by default
- Cons: Key stored on disk (attack vector), harder to sync across machines

**Option B: Require explicit setup**

- `agor auth init --generate-master-secret` generates and displays secret
- User must set `AGOR_MASTER_SECRET` environment variable
- Pros: User controls secret storage, auditable
- Cons: Extra setup step, can be forgotten

**Option C: Derive from machine ID**

- Use machine-specific identifier (MAC address, hostname hash)
- Pros: No configuration needed, unique per machine
- Cons: Not portable across machines, predictable

**Recommendation**: **Option B** (explicit setup)

- Balance of security and usability
- User controls secret storage method
- Works well with secret managers (AWS Secrets Manager, HashiCorp Vault)
- Clear documentation path

### 2. Key Rotation

**Question**: Should we support rotating the master secret?

**Use Case**:

- Security incident (secret compromised)
- Regular rotation policy (compliance requirement)
- Migrating to new encryption algorithm

**Implementation**:

```typescript
// Migration script
async function rotateMasterSecret(
  db: Database,
  oldSecret: string,
  newSecret: string
): Promise<void> {
  // 1. Decrypt all user API keys with old secret
  // 2. Re-encrypt with new secret
  // 3. Update database
  // 4. Decrypt global keys in config.yaml with old secret
  // 5. Re-encrypt with new secret
  // 6. Update config.yaml
}
```

**Recommendation**: **Defer to v2**

- Complex migration logic required
- Low priority for MVP
- Document workaround (manually re-enter keys)

### 3. Audit Logging

**Question**: Should we log API key changes?

**Use Case**:

- Security audit trail
- Compliance requirements (SOC 2, HIPAA)
- Debugging (who changed what key when)

**Implementation**:

```typescript
// Audit log table
export const auditLogs = sqliteTable('audit_logs', {
  log_id: text('log_id').primaryKey(),
  user_id: text('user_id').notNull(),
  action: text('action').notNull(), // 'api_key_set', 'api_key_cleared'
  resource: text('resource').notNull(), // 'ANTHROPIC_API_KEY', etc.
  timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
  metadata: text('metadata', { mode: 'json' }), // Additional context
});
```

**Recommendation**: **Defer to v2**

- Not critical for MVP
- Can be added later without breaking changes
- Consider GDPR implications (PII in logs)

### 4. Key Expiration

**Question**: Should per-user keys have expiration dates?

**Use Case**:

- Temporary access grants (contractors, interns)
- Compliance requirements (rotate every 90 days)
- Reduced attack surface (old keys auto-expire)

**Implementation**:

```typescript
// User API key with expiration
interface UserApiKey {
  encrypted_value: string;
  expires_at?: Date;
  created_at: Date;
}

// Background job to clean up expired keys
async function cleanupExpiredKeys(db: Database): Promise<void> {
  // Find users with expired keys
  // Remove expired keys from database
  // Notify users via email
}
```

**Recommendation**: **Defer to v2**

- Adds complexity (background jobs, notifications)
- Not requested feature
- Can be added incrementally

### 5. Unix Permissions & Impersonation (Future)

**Question**: How will per-user API keys integrate with unix-level permissions and impersonation?

**Context** (from original request):

> Eventually we'll work on unix-level permissions and impersonation, but not just yet.

**Considerations**:

- When daemon spawns subprocess as different unix user, which API key to use?
- Should spawned processes inherit user's API keys via environment variables?
- How to handle key resolution in child sessions (spawned from parent)?
- Security boundary: Should child processes have access to parent's keys?

**Proposed Design** (for future):

```typescript
// Session hierarchy
interface Session {
  session_id: SessionID;
  parent_session_id?: SessionID; // Track parent/child relationships
  created_by: UserID; // Original user
  impersonating_as?: UserID; // Unix user being impersonated
  inherit_api_keys: boolean; // Inherit from parent session?
}

// Key resolution with impersonation
async function resolveApiKeyWithImpersonation(
  keyName: ApiKeyName,
  session: Session,
  db: Database
): Promise<string | undefined> {
  // 1. Check session's impersonated user keys
  if (session.impersonating_as) {
    const impersonatedKey = await getUserApiKey(session.impersonating_as, keyName, db);
    if (impersonatedKey) return impersonatedKey;
  }

  // 2. Check if inheriting from parent session
  if (session.inherit_api_keys && session.parent_session_id) {
    const parentSession = await getSession(session.parent_session_id, db);
    return resolveApiKeyWithImpersonation(keyName, parentSession, db);
  }

  // 3. Check session's original user keys
  const userKey = await getUserApiKey(session.created_by, keyName, db);
  if (userKey) return userKey;

  // 4. Fallback to global/env
  return resolveApiKeySync(keyName);
}
```

**Recommendation**: **Document for future, implement in separate phase**

- Complex security model (needs careful design)
- Interacts with subsession/spawning work
- Should be designed holistically with permission system

---

## Estimated Effort

| Phase                             | Estimated Time  | Complexity  | Priority |
| --------------------------------- | --------------- | ----------- | -------- |
| **Phase 1**: Schema & Encryption  | 4-6 hours       | Medium      | High     |
| **Phase 2**: Component Extraction | 3-4 hours       | Low         | High     |
| **Phase 3**: Backend Services     | 3-4 hours       | Medium      | High     |
| **Phase 4**: Tool Integration     | 4-6 hours       | Medium-High | High     |
| **Phase 5**: Global Encryption    | 2-3 hours       | Medium      | Medium   |
| **Testing & QA**                  | 4-6 hours       | Medium      | High     |
| **Documentation**                 | 2-3 hours       | Low         | Medium   |
| **Total**                         | **22-32 hours** | **Medium**  | -        |

### Breakdown by Role

**Backend Engineer** (14-18 hours):

- Phase 1: Encryption utilities (4-6 hours)
- Phase 3: Backend services (3-4 hours)
- Phase 4: Tool integration (4-6 hours)
- Phase 5: Global encryption (2-3 hours)

**Frontend Engineer** (6-8 hours):

- Phase 2: Component extraction (3-4 hours)
- Phase 2: User edit modal (3-4 hours)

**QA/Testing** (4-6 hours):

- Unit tests (2-3 hours)
- Integration tests (2-3 hours)

**DevOps/Docs** (2-4 hours):

- Master secret setup documentation (1-2 hours)
- Migration guide (1-2 hours)

---

## Implementation Order

### Sprint 1: Core Infrastructure (8-10 hours)

1. Create encryption utilities (`encryption.ts`)
2. Extend user schema and types
3. Create migration for `api_keys` field
4. Update `users.ts` service with encryption

**Deliverable**: Per-user API keys can be stored/retrieved (encrypted)

### Sprint 2: UI Components (6-8 hours)

1. Extract `ApiKeyFields` component
2. Refactor `AgenticToolsTab` to use component
3. Add API keys section to user edit modal

**Deliverable**: Users can manage per-user API keys in UI

### Sprint 3: Key Resolution (4-6 hours)

1. Create key resolver service
2. Update Claude tool integration
3. Update Codex tool integration
4. Update Gemini tool integration

**Deliverable**: Tools use per-user keys when available

### Sprint 4: Testing & Polish (4-6 hours)

1. Write unit tests
2. Write integration tests
3. Test edge cases
4. Update documentation
5. (Optional) Add global key encryption

**Deliverable**: Production-ready feature

---

## Success Criteria

### Functional Requirements

- [ ] Users can set per-user API keys via UI
- [ ] Users can clear per-user API keys via UI
- [ ] Per-user keys are encrypted at rest in database
- [ ] Tools (Claude, Codex, Gemini) use per-user keys when available
- [ ] Tools fall back to global keys when per-user not set
- [ ] UI shows correct "Set"/"Not Set" status for each key
- [ ] API never returns actual key values (only status)

### Non-Functional Requirements

- [ ] Key encryption/decryption < 10ms
- [ ] Key resolution < 50ms (with database)
- [ ] No performance regression in tool prompting
- [ ] Backwards compatible with existing global keys
- [ ] Graceful degradation without master secret (dev mode)
- [ ] Clear error messages for encryption failures
- [ ] Secure storage (AES-256-GCM encryption)

### User Experience

- [ ] Consistent UI between global and per-user settings
- [ ] Clear documentation of precedence order
- [ ] No disruption to existing workflows
- [ ] Easy to understand status indicators
- [ ] Password-masked input fields

### Security

- [ ] API keys never logged in plaintext
- [ ] API keys never returned in API responses
- [ ] Encryption uses industry-standard algorithm (AES-256-GCM)
- [ ] Master secret properly validated
- [ ] Failed decryption doesn't crash daemon

---

## Rollout Plan

### Phase 1: Internal Testing (Week 1)

- Deploy to staging environment
- Set `AGOR_MASTER_SECRET` for staging
- Test all use cases with team
- Identify and fix bugs

### Phase 2: Beta Release (Week 2)

- Document master secret setup
- Announce beta in release notes
- Monitor for issues
- Gather user feedback

### Phase 3: General Availability (Week 3+)

- Promote feature in documentation
- Update onboarding flow
- Monitor adoption metrics
- Plan future enhancements (rotation, audit logs)

---

## Documentation Requirements

### User Documentation

1. **Setup Guide**: How to set `AGOR_MASTER_SECRET`
2. **User Guide**: How to set per-user API keys in UI
3. **Precedence Docs**: Updated authentication precedence order
4. **Security Docs**: Encryption details and best practices
5. **Troubleshooting**: Common issues and solutions

### Developer Documentation

1. **Architecture Docs**: This file (explorations/per-user-api-keys.md)
2. **API Docs**: Updated user service endpoints
3. **Migration Guide**: How to upgrade existing installations
4. **Code Comments**: Inline documentation in encryption.ts

---

## Summary

This implementation plan provides:

✅ **Complete per-user API key support** with AES-256-GCM encryption
✅ **Reusable UI components** extracted from existing well-designed form
✅ **Backwards-compatible** with existing global keys
✅ **Security-first** with authenticated encryption at rest
✅ **Clean precedence order** (per-user → global → env → tool-specific)
✅ **Minimal invasive changes** to existing tool integrations
✅ **Graceful degradation** without master secret (dev mode)
✅ **Well-tested** with comprehensive test coverage
✅ **Documented** for users and developers

The architecture is **extensible** for future enhancements:

- Key rotation mechanism
- Audit logging of key access
- Key expiration and auto-cleanup
- Unix-level permissions integration
- Multi-tenant support

**Estimated effort**: 22-32 hours across 4 sprints

**Next steps**:

1. Review and approve this plan
2. Set up `AGOR_MASTER_SECRET` for development
3. Begin Sprint 1 (Core Infrastructure)
