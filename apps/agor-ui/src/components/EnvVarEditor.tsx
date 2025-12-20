import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Input, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { Tag } from './Tag';

const { Text } = Typography;

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
  const [error, setError] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return;

    try {
      setError(null);
      await onSave(newKey.trim(), newValue.trim());
      setNewKey('');
      setNewValue('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save environment variable';
      setError(message);
    }
  };

  const handleUpdate = async (key: string) => {
    if (!editingValue.trim()) return;

    try {
      setError(null);
      await onSave(key, editingValue.trim());
      setEditingKey(null);
      setEditingValue('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update environment variable';
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
                onChange={(e) => setEditingValue(e.target.value)}
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
          onClick={() => handleDeleteClick(record.key)}
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
      <Text type="secondary">
        Environment variables are encrypted at rest and available to all agent operations
        (subprocesses, terminal sessions, environment commands). Common variables: GITHUB_TOKEN,
        NPM_TOKEN, AWS_ACCESS_KEY_ID, etc.
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
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
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
