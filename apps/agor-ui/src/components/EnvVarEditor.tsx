import { ENV_VAR_SCOPES_V05, type EnvVarMetadata, type EnvVarScope } from '@agor-live/client';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Input, Select, Space, Table, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { Tag } from './Tag';

const { Text } = Typography;

/**
 * Row-level metadata as shown to the editor. Accepts the canonical
 * `EnvVarMetadata` shape (server v0.5+) but is tolerant of legacy callers that
 * still pass a plain boolean flag (implicit `scope: 'global'`).
 */
export type EnvVarEntry = EnvVarMetadata | boolean;

export interface EnvVarEditorProps {
  /** Current env vars — metadata per key (scope-aware). */
  envVars: Record<string, EnvVarEntry>;
  /** Callback when user adds/updates a variable (scope is included). */
  onSave: (key: string, value: string, scope: EnvVarScope) => Promise<void>;
  /** Callback when user changes scope for an existing variable. */
  onScopeChange?: (key: string, scope: EnvVarScope) => Promise<void>;
  /** Callback when user deletes a variable */
  onDelete: (key: string) => Promise<void>;
  /** Loading state for operations */
  loading?: Record<string, boolean>;
  /** Disable all fields */
  disabled?: boolean;
}

function entryToMetadata(entry: EnvVarEntry): { set: boolean; scope: EnvVarScope } {
  if (typeof entry === 'boolean') {
    return { set: entry, scope: 'global' };
  }
  return { set: !!entry.set, scope: entry.scope };
}

const SCOPE_LABEL: Record<EnvVarScope, string> = {
  global: 'Global',
  session: 'Session',
  repo: 'Repo',
  mcp_server: 'MCP server',
  artifact_feature: 'Artifact feature',
  executor: 'Executor',
};

const SCOPE_COLOR: Record<EnvVarScope, string> = {
  global: 'blue',
  session: 'purple',
  repo: 'default',
  mcp_server: 'default',
  artifact_feature: 'default',
  executor: 'default',
};

const SCOPE_OPTIONS = ENV_VAR_SCOPES_V05.map((s) => ({
  value: s,
  label: SCOPE_LABEL[s],
}));

export const EnvVarEditor: React.FC<EnvVarEditorProps> = ({
  envVars,
  onSave,
  onScopeChange,
  onDelete,
  loading = {},
  disabled = false,
}) => {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newScope, setNewScope] = useState<EnvVarScope>('global');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return;

    try {
      setError(null);
      await onSave(newKey.trim(), newValue.trim(), newScope);
      setNewKey('');
      setNewValue('');
      setNewScope('global');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save environment variable';
      setError(message);
    }
  };

  const handleUpdate = async (key: string, scope: EnvVarScope) => {
    if (!editingValue.trim()) return;

    try {
      setError(null);
      await onSave(key, editingValue.trim(), scope);
      setEditingKey(null);
      setEditingValue('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update environment variable';
      setError(message);
    }
  };

  const handleScopeChange = async (key: string, scope: EnvVarScope) => {
    if (!onScopeChange) return;
    try {
      setError(null);
      await onScopeChange(key, scope);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update scope';
      setError(message);
    }
  };

  const handleDeleteClick = async (key: string) => {
    try {
      setError(null);
      await onDelete(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete environment variable';
      setError(message);
    }
  };

  type Row = { key: string; isSet: boolean; scope: EnvVarScope };

  const columns = [
    {
      title: 'Variable Name',
      dataIndex: 'key',
      key: 'key',
      width: '30%',
      ellipsis: true,
      render: (key: string) => <code>{key}</code>,
    },
    {
      title: 'Scope',
      dataIndex: 'scope',
      key: 'scope',
      width: 140,
      render: (scope: EnvVarScope, record: Row) => {
        if (onScopeChange) {
          return (
            <Select
              value={scope}
              size="small"
              style={{ width: '100%', minWidth: 0 }}
              popupMatchSelectWidth={false}
              disabled={disabled || loading[record.key]}
              onChange={(next) => handleScopeChange(record.key, next)}
              options={SCOPE_OPTIONS}
            />
          );
        }
        return <Tag color={SCOPE_COLOR[scope]}>{SCOPE_LABEL[scope]}</Tag>;
      },
    },
    {
      title: 'Value',
      dataIndex: 'isSet',
      key: 'value',
      render: (isSet: boolean, record: Row) => {
        const isEditing = editingKey === record.key;

        if (isEditing) {
          return (
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password
                placeholder="Enter new value"
                value={editingValue}
                onChange={(e) => setEditingValue(e.target.value)}
                onPressEnter={() => handleUpdate(record.key, record.scope)}
                autoFocus
                disabled={disabled}
                style={{ flex: 1, minWidth: 180 }}
              />
              <Button
                type="primary"
                onClick={() => handleUpdate(record.key, record.scope)}
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
      width: 72,
      align: 'center' as const,
      render: (_: unknown, record: Row) => (
        <Tooltip title="Delete">
          <Button
            danger
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={() => handleDeleteClick(record.key)}
            loading={loading[record.key]}
            disabled={disabled}
            aria-label={`Delete ${record.key}`}
          />
        </Tooltip>
      ),
    },
  ];

  const dataSource: Row[] = Object.entries(envVars).map(([key, entry]) => {
    const meta = entryToMetadata(entry);
    return {
      key,
      isSet: meta.set,
      scope: meta.scope,
    };
  });

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Text type="secondary">
        Environment variables are encrypted at rest. <b>Global</b> vars are exported to every
        session you own. <b>Session</b> vars are only exported to sessions where you explicitly
        select them (configure per-session under Session → Settings → Env vars).
      </Text>

      {error && (
        <div
          style={{ color: '#ff4d4f', padding: '8px', borderRadius: '4px', background: '#fff1f0' }}
        >
          <Text type="danger">{error}</Text>
        </div>
      )}

      {/* Existing Variables Table */}
      <Table
        columns={columns}
        dataSource={dataSource}
        pagination={false}
        size="small"
        locale={{ emptyText: 'No environment variables configured' }}
        style={{ width: '100%' }}
      />

      {/* Add New Variable Form */}
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Text strong>Add New Variable</Text>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            placeholder="Variable name (e.g., GITHUB_TOKEN)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onPressEnter={handleAdd}
            style={{ width: '30%' }}
            disabled={disabled}
          />
          <Select<EnvVarScope>
            value={newScope}
            onChange={setNewScope}
            style={{ width: 140 }}
            disabled={disabled}
            options={SCOPE_OPTIONS}
          />
          <Input.Password
            placeholder="Value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
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
