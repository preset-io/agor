import type { AgorClient } from '@agor-live/client';
import { CopyOutlined, DeleteOutlined, KeyOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Popconfirm, Space, Table, Typography, theme } from 'antd';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  type AuthorityOperation,
  useAuthorityOperationGuard,
} from '../../hooks/useAuthorityOperationGuard';
import { copyToClipboard } from '../../utils/clipboard';
import { useThemedMessage } from '../../utils/message';
import { filterBySettingsSearch } from '../../utils/settingsSearch';
import { HighlightMatch } from '../HighlightMatch';
import { AdaptiveSettingsModal } from './AdaptiveSettingsModal';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';

interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at?: string;
}

interface PersonalApiKeysTabProps {
  client: AgorClient | null;
  identityKey: string | null;
  operationScope: readonly unknown[] | null;
}

export const PersonalApiKeysTab: React.FC<PersonalApiKeysTabProps> = ({
  client,
  identityKey,
  operationScope,
}) => {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const operationGuard = useAuthorityOperationGuard(operationScope);

  // A full key is caller-private and is intentionally erased in layout, rather
  // than waiting for passive cleanup, when Settings changes identity in place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: authorityKey intentionally erases the displayed raw key
  useLayoutEffect(() => {
    setKeys([]);
    setNewKeyName('');
    setShowCreateModal(false);
    setNewlyCreatedKey(null);
    setDeletingId(null);
  }, [identityKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: operationScope intentionally releases stale generation-owned UI locks
  useLayoutEffect(() => {
    setLoading(false);
    setCreating(false);
    setDeletingId(null);
  }, [operationScope]);

  const fetchKeys = useCallback(
    async (operation?: AuthorityOperation) => {
      const request = operation ?? operationGuard.begin();
      if (!client || !request.isCurrent()) return;
      setLoading(true);
      try {
        const result = await client.service('api/v1/user/api-keys').findAll({});
        if (!request.isCurrent()) return;
        setKeys(result as ApiKeyEntry[]);
      } catch (err) {
        if (!request.isCurrent()) return;
        console.error('Failed to fetch API keys:', err);
      } finally {
        if (request.isCurrent()) setLoading(false);
      }
    },
    [client, operationGuard]
  );

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleCreate = async () => {
    const operation = operationGuard.begin();
    if (!client || !newKeyName.trim() || !operation.isCurrent()) return;
    const name = newKeyName.trim();
    setCreating(true);
    try {
      const result = (await client.service('api/v1/user/api-keys').create({ name })) as {
        rawKey: string;
        key: ApiKeyEntry;
      };
      if (!operation.isCurrent()) return;
      setNewlyCreatedKey(result.rawKey);
      setNewKeyName('');
      await fetchKeys(operation);
    } catch (err: unknown) {
      if (!operation.isCurrent()) return;
      showError((err as Error)?.message || 'Failed to create API key');
    } finally {
      if (operation.isCurrent()) setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    const operation = operationGuard.begin();
    if (!client || !operation.isCurrent()) return;
    setDeletingId(id);
    try {
      await client.service('api/v1/user/api-keys').remove(id);
      if (!operation.isCurrent()) return;
      showSuccess('API key revoked');
      await fetchKeys(operation);
    } catch (err: unknown) {
      if (!operation.isCurrent()) return;
      showError((err as Error)?.message || 'Failed to delete API key');
    } finally {
      if (operation.isCurrent()) setDeletingId(null);
    }
  };

  const handleCopy = async (text: string) => {
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
    const ok = await copyToClipboard(text);
    if (!operation.isCurrent()) return;
    if (ok) {
      showSuccess('Copied to clipboard');
    } else {
      showError('Failed to copy to clipboard');
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <HighlightMatch text={name} query={searchTerm} />,
    },
    {
      title: 'Key',
      dataIndex: 'prefix',
      key: 'prefix',
      render: (prefix: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          <HighlightMatch text={prefix} query={searchTerm} />
          ...
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

  const filteredKeys = useMemo(
    () =>
      filterBySettingsSearch(keys, searchTerm, [
        (key) => key.name,
        (key) => key.prefix,
        (key) => key.id,
        (key) => key.created_at,
        (key) => key.last_used_at,
      ]),
    [keys, searchTerm]
  );

  return (
    <div>
      <ResponsiveSettingsHeader
        description="Manage personal API keys."
        actions={(compact) => (
          <Space wrap style={{ width: compact ? '100%' : undefined }}>
            <Input
              allowClear
              placeholder="Search name, prefix, or dates"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              style={{
                width: compact ? '100%' : 300,
                flex: compact ? '1 1 100%' : undefined,
              }}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreateModal(true)}>
              Create New Key
            </Button>
          </Space>
        )}
      />

      <Table
        dataSource={filteredKeys}
        columns={columns}
        scroll={{ x: 560 }}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="small"
        locale={{ emptyText: 'No API keys yet' }}
      />

      {/* Create key modal */}
      <AdaptiveSettingsModal
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
      </AdaptiveSettingsModal>

      {/* Show key once modal */}
      <AdaptiveSettingsModal
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
          title="Copy your API key now"
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
      </AdaptiveSettingsModal>
    </div>
  );
};
