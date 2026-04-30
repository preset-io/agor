import type { AgorClient } from '@agor-live/client';
import { CopyOutlined, DeleteOutlined, KeyOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Input,
  Modal,
  message,
  Popconfirm,
  Space,
  Table,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';

interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at?: string;
}

interface PersonalApiKeysTabProps {
  client: AgorClient | null;
}

export const PersonalApiKeysTab: React.FC<PersonalApiKeysTabProps> = ({ client }) => {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { token } = theme.useToken();

  const fetchKeys = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.service('api/v1/user/api-keys').findAll({});
      setKeys(result as ApiKeyEntry[]);
    } catch (err) {
      console.error('Failed to fetch API keys:', err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleCreate = async () => {
    if (!client || !newKeyName.trim()) return;
    setCreating(true);
    try {
      const result = (await client
        .service('api/v1/user/api-keys')
        .create({ name: newKeyName.trim() })) as { rawKey: string; key: ApiKeyEntry };
      setNewlyCreatedKey(result.rawKey);
      setNewKeyName('');
      await fetchKeys();
    } catch (err: unknown) {
      message.error((err as Error)?.message || 'Failed to create API key');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!client) return;
    setDeletingId(id);
    try {
      await client.service('api/v1/user/api-keys').remove(id);
      message.success('API key revoked');
      await fetchKeys();
    } catch (err: unknown) {
      message.error((err as Error)?.message || 'Failed to delete API key');
    } finally {
      setDeletingId(null);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    message.success('Copied to clipboard');
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Key',
      dataIndex: 'prefix',
      key: 'prefix',
      render: (prefix: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {prefix}...
        </Typography.Text>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
    {
      title: 'Last Used',
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      render: (date?: string) => (date ? new Date(date).toLocaleDateString() : 'Never'),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, record: ApiKeyEntry) => (
        <Popconfirm
          title="Revoke this API key?"
          description="Any applications using this key will lose access."
          onConfirm={() => handleDelete(record.id)}
          okText="Revoke"
          okType="danger"
        >
          <Button
            type="text"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingId === record.id}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Agor API tokens allow you to authenticate with the Agor API from scripts, CI pipelines, and
        external tools. Tokens have the same permissions as your user account.
      </Typography.Paragraph>

      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => setShowCreateModal(true)}
        style={{ marginBottom: 16 }}
      >
        Create New Key
      </Button>

      <Table
        dataSource={keys}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="small"
        locale={{ emptyText: 'No API keys yet' }}
      />

      {/* Create key modal */}
      <Modal
        title="Create API Key"
        open={showCreateModal && !newlyCreatedKey}
        onOk={handleCreate}
        onCancel={() => {
          setShowCreateModal(false);
          setNewKeyName('');
        }}
        okText="Create"
        okButtonProps={{ disabled: !newKeyName.trim(), loading: creating }}
      >
        <Typography.Paragraph type="secondary">
          Give your key a descriptive name so you can identify it later.
        </Typography.Paragraph>
        <Input
          placeholder="e.g., CI Pipeline, Local Development"
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          onPressEnter={handleCreate}
          maxLength={100}
          autoFocus
        />
      </Modal>

      {/* Show key once modal */}
      <Modal
        title={
          <Space>
            <KeyOutlined />
            API Key Created
          </Space>
        }
        open={!!newlyCreatedKey}
        onOk={() => {
          setNewlyCreatedKey(null);
          setShowCreateModal(false);
        }}
        onCancel={() => {
          setNewlyCreatedKey(null);
          setShowCreateModal(false);
        }}
        okText="Done"
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <Alert
          type="warning"
          showIcon
          message="Copy your API key now"
          description="This is the only time the full key will be shown. Store it securely."
          style={{ marginBottom: 16 }}
        />
        <Input.TextArea
          value={newlyCreatedKey || ''}
          readOnly
          autoSize={{ minRows: 2 }}
          style={{
            fontFamily: 'monospace',
            fontSize: 13,
            marginBottom: 8,
            background: token.colorBgContainer,
          }}
        />
        <Button
          icon={<CopyOutlined />}
          onClick={() => newlyCreatedKey && handleCopy(newlyCreatedKey)}
          block
        >
          Copy to Clipboard
        </Button>
      </Modal>
    </div>
  );
};
