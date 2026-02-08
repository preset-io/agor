import type { AgorClient } from '@agor/core/api';
import type { ChannelType, GatewayChannel, User, Worktree } from '@agor/core/types';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  MessageOutlined,
  PlusOutlined,
  SlackOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';

interface GatewayChannelsTableProps {
  client: AgorClient | null;
  gatewayChannelById: Map<string, GatewayChannel>;
  worktreeById: Map<string, Worktree>;
  userById: Map<string, User>;
  onCreate?: (data: Partial<GatewayChannel>) => void;
  onUpdate?: (channelId: string, updates: Partial<GatewayChannel>) => void;
  onDelete?: (channelId: string) => void;
}

const CHANNEL_TYPE_OPTIONS: { value: ChannelType; label: string; icon: React.ReactNode }[] = [
  { value: 'slack', label: 'Slack', icon: <SlackOutlined /> },
  { value: 'discord', label: 'Discord', icon: <MessageOutlined /> },
  { value: 'whatsapp', label: 'WhatsApp', icon: <MessageOutlined /> },
  { value: 'telegram', label: 'Telegram', icon: <MessageOutlined /> },
];

function getChannelTypeIcon(type: ChannelType): React.ReactNode {
  switch (type) {
    case 'slack':
      return <SlackOutlined />;
    default:
      return <MessageOutlined />;
  }
}

function getChannelTypeColor(type: ChannelType): string {
  switch (type) {
    case 'slack':
      return 'purple';
    case 'discord':
      return 'blue';
    case 'whatsapp':
      return 'green';
    case 'telegram':
      return 'cyan';
    default:
      return 'default';
  }
}

export const GatewayChannelsTable: React.FC<GatewayChannelsTableProps> = ({
  client,
  gatewayChannelById,
  worktreeById,
  userById,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const { showSuccess, showError } = useThemedMessage();
  const { token } = theme.useToken();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<GatewayChannel | null>(null);
  const [channelType, setChannelType] = useState<ChannelType>('slack');
  const [createdChannelKey, setCreatedChannelKey] = useState<string | null>(null);
  const [createdChannelType, setCreatedChannelType] = useState<ChannelType | null>(null);
  const [form] = Form.useForm();

  const worktreeOptions = Array.from(worktreeById.values()).map((wt) => ({
    value: wt.worktree_id,
    label: wt.name || wt.ref || wt.worktree_id,
  }));

  const userOptions = Array.from(userById.values()).map((u) => ({
    value: u.user_id,
    label: u.name || u.email || u.user_id,
  }));

  const handleCreate = () => {
    form
      .validateFields()
      .then((values) => {
        const config: Record<string, unknown> = {};
        if (values.channel_type === 'slack') {
          if (values.bot_token) config.bot_token = values.bot_token;
          if (values.app_token) config.app_token = values.app_token;
          if (values.connection_mode) config.connection_mode = values.connection_mode;
        }

        const data: Partial<GatewayChannel> = {
          name: values.name,
          channel_type: values.channel_type,
          target_worktree_id: values.target_worktree_id,
          agor_user_id: values.agor_user_id,
          config,
          enabled: values.enabled ?? true,
        };

        onCreate?.(data);

        // Show success state with channel key
        // In a real implementation the parent would return the created channel
        // with its generated key. For now we show a placeholder.
        setCreatedChannelType(values.channel_type);
        setCreatedChannelKey('pending');

        form.resetFields();
        setCreateModalOpen(false);
        setChannelType('slack');
      })
      .catch((error) => {
        console.error('Form validation failed:', error);
        if (error.errorFields?.length > 0) {
          showError(error.errorFields[0].errors[0] || 'Please fill in required fields');
        }
      });
  };

  const handleEdit = (channel: GatewayChannel) => {
    setEditingChannel(channel);
    setChannelType(channel.channel_type);
    form.resetFields();
    form.setFieldsValue({
      name: channel.name,
      channel_type: channel.channel_type,
      target_worktree_id: channel.target_worktree_id,
      agor_user_id: channel.agor_user_id,
      enabled: channel.enabled,
      connection_mode: (channel.config as Record<string, unknown>)?.connection_mode || 'socket',
      // Don't pre-populate tokens — they're encrypted
    });
    setEditModalOpen(true);
  };

  const handleUpdate = () => {
    if (!editingChannel) return;

    form
      .validateFields()
      .then((values) => {
        const config: Record<string, unknown> = { ...(editingChannel.config || {}) };
        if (values.channel_type === 'slack') {
          // Only update tokens if user entered new values
          if (values.bot_token) config.bot_token = values.bot_token;
          if (values.app_token) config.app_token = values.app_token;
          if (values.connection_mode) config.connection_mode = values.connection_mode;
        }

        const updates: Partial<GatewayChannel> = {
          name: values.name,
          channel_type: values.channel_type,
          target_worktree_id: values.target_worktree_id,
          agor_user_id: values.agor_user_id,
          config,
          enabled: values.enabled,
        };

        onUpdate?.(editingChannel.id, updates);
        showSuccess('Gateway channel updated');
        form.resetFields();
        setEditModalOpen(false);
        setEditingChannel(null);
        setChannelType('slack');
      })
      .catch((error) => {
        console.error('Form validation failed:', error);
        if (error.errorFields?.length > 0) {
          showError(error.errorFields[0].errors[0] || 'Please fill in required fields');
        }
      });
  };

  const handleToggleEnabled = (channel: GatewayChannel) => {
    onUpdate?.(channel.id, { enabled: !channel.enabled });
  };

  const handleDelete = (channelId: string) => {
    onDelete?.(channelId);
  };

  const handleCopyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      showSuccess('Channel key copied to clipboard');
    } catch {
      showError('Failed to copy to clipboard');
    }
  };

  const renderPlatformConfig = (type: ChannelType, mode: 'create' | 'edit') => {
    if (type === 'slack') {
      return (
        <>
          <Form.Item
            label="Bot Token"
            name="bot_token"
            rules={mode === 'create' ? [{ required: true, message: 'Bot token is required' }] : []}
            tooltip="Slack Bot User OAuth Token (xoxb-...)"
          >
            <Input.Password placeholder={mode === 'edit' ? '••••••••' : 'xoxb-...'} />
          </Form.Item>

          <Form.Item
            label="App Token"
            name="app_token"
            rules={mode === 'create' ? [{ required: true, message: 'App token is required' }] : []}
            tooltip="Slack App-Level Token for Socket Mode (xapp-...)"
          >
            <Input.Password placeholder={mode === 'edit' ? '••••••••' : 'xapp-...'} />
          </Form.Item>

          <Form.Item
            label="Connection Mode"
            name="connection_mode"
            initialValue="socket"
            tooltip="How the gateway connects to Slack"
          >
            <Select>
              <Select.Option value="socket">Socket Mode</Select.Option>
              <Select.Option value="webhook">Webhook</Select.Option>
            </Select>
          </Form.Item>
        </>
      );
    }

    return (
      <Alert
        message={`${type.charAt(0).toUpperCase() + type.slice(1)} support coming soon`}
        description="This platform integration is not yet available. Slack is currently the only supported platform."
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />
    );
  };

  const columns = [
    {
      title: '',
      key: 'status',
      width: 40,
      render: (_: unknown, channel: GatewayChannel) => (
        <Badge
          status={channel.enabled ? 'success' : 'default'}
          title={channel.enabled ? 'Enabled' : 'Disabled'}
        />
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 180,
    },
    {
      title: 'Type',
      dataIndex: 'channel_type',
      key: 'channel_type',
      width: 120,
      render: (type: ChannelType) => (
        <Tag icon={getChannelTypeIcon(type)} color={getChannelTypeColor(type)}>
          {type.charAt(0).toUpperCase() + type.slice(1)}
        </Tag>
      ),
    },
    {
      title: 'Target Worktree',
      dataIndex: 'target_worktree_id',
      key: 'target_worktree_id',
      width: 180,
      render: (worktreeId: string) => {
        const wt = worktreeById.get(worktreeId);
        return (
          <Typography.Text type="secondary">
            {wt ? wt.name || wt.ref || worktreeId : worktreeId}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Last Message',
      dataIndex: 'last_message_at',
      key: 'last_message_at',
      width: 160,
      render: (time: string | null) =>
        time ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {new Date(time).toLocaleString()}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Never
          </Typography.Text>
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      render: (_: unknown, channel: GatewayChannel) => (
        <Space size="small">
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(channel)}
            title="Edit"
          />
          <Switch
            size="small"
            checked={channel.enabled}
            onChange={() => handleToggleEnabled(channel)}
            title={channel.enabled ? 'Disable' : 'Enable'}
          />
          <Popconfirm
            title="Delete gateway channel?"
            description={`Are you sure you want to delete "${channel.name}"? All thread mappings will be lost.`}
            onConfirm={() => handleDelete(channel.id)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger title="Delete" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const channels = mapToArray(gatewayChannelById);

  return (
    <div>
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography.Text type="secondary">
          Route messages from Slack, Discord, and other platforms to Agor sessions.
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
          Add Channel
        </Button>
      </div>

      {channels.length === 0 ? (
        <div
          style={{
            padding: '60px 20px',
            textAlign: 'center',
            color: token.colorTextTertiary,
          }}
        >
          <MessageOutlined style={{ fontSize: 48, marginBottom: 16, display: 'block' }} />
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            No channels configured.
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Add a channel to route messages from Slack, Discord, or other platforms to Agor
            sessions.
          </Typography.Text>
        </div>
      ) : (
        <Table
          dataSource={channels}
          columns={columns}
          rowKey="id"
          pagination={{ pageSize: 10, showSizeChanger: true }}
          size="small"
        />
      )}

      {/* Create Channel Modal */}
      <Modal
        title="Add Gateway Channel"
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={() => {
          form.resetFields();
          setCreateModalOpen(false);
          setChannelType('slack');
        }}
        okText="Create"
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            label="Channel Type"
            name="channel_type"
            initialValue="slack"
            rules={[{ required: true }]}
          >
            <Select onChange={(value: ChannelType) => setChannelType(value)}>
              {CHANNEL_TYPE_OPTIONS.map((opt) => (
                <Select.Option key={opt.value} value={opt.value}>
                  <Space>
                    {opt.icon}
                    {opt.label}
                  </Space>
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label="Name"
            name="name"
            rules={[{ required: true, message: 'Please enter a channel name' }]}
          >
            <Input placeholder="e.g., Team Slack, Personal Discord" />
          </Form.Item>

          <Form.Item
            label="Target Worktree"
            name="target_worktree_id"
            rules={[{ required: true, message: 'Please select a target worktree' }]}
            tooltip="New sessions from this channel will be created in this worktree"
          >
            <Select
              placeholder="Select a worktree"
              showSearch
              optionFilterProp="label"
              options={worktreeOptions}
            />
          </Form.Item>

          <Form.Item
            label="Post messages as"
            name="agor_user_id"
            rules={[{ required: true, message: 'Please select a user' }]}
            tooltip="Messages from this channel will be attributed to this Agor user"
          >
            <Select
              placeholder="Select a user"
              showSearch
              optionFilterProp="label"
              options={userOptions}
            />
          </Form.Item>

          <Form.Item label="Enabled" name="enabled" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>

          <Typography.Text strong style={{ display: 'block', marginBottom: 12, marginTop: 8 }}>
            Platform Configuration
          </Typography.Text>

          {renderPlatformConfig(channelType, 'create')}
        </Form>
      </Modal>

      {/* Edit Channel Modal */}
      <Modal
        title="Edit Gateway Channel"
        open={editModalOpen}
        onOk={handleUpdate}
        onCancel={() => {
          form.resetFields();
          setEditModalOpen(false);
          setEditingChannel(null);
          setChannelType('slack');
        }}
        okText="Save"
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          {editingChannel && (
            <Form.Item label="Channel Key">
              <Input.Search
                value={editingChannel.channel_key}
                readOnly
                enterButton={<CopyOutlined />}
                onSearch={() => handleCopyKey(editingChannel.channel_key)}
              />
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, marginTop: 4, display: 'block' }}
              >
                Use this key to authenticate inbound messages from the platform.
              </Typography.Text>
            </Form.Item>
          )}

          <Form.Item label="Channel Type" name="channel_type" rules={[{ required: true }]}>
            <Select onChange={(value: ChannelType) => setChannelType(value)}>
              {CHANNEL_TYPE_OPTIONS.map((opt) => (
                <Select.Option key={opt.value} value={opt.value}>
                  <Space>
                    {opt.icon}
                    {opt.label}
                  </Space>
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label="Name"
            name="name"
            rules={[{ required: true, message: 'Please enter a channel name' }]}
          >
            <Input placeholder="e.g., Team Slack, Personal Discord" />
          </Form.Item>

          <Form.Item
            label="Target Worktree"
            name="target_worktree_id"
            rules={[{ required: true, message: 'Please select a target worktree' }]}
          >
            <Select
              placeholder="Select a worktree"
              showSearch
              optionFilterProp="label"
              options={worktreeOptions}
            />
          </Form.Item>

          <Form.Item
            label="Post messages as"
            name="agor_user_id"
            rules={[{ required: true, message: 'Please select a user' }]}
          >
            <Select
              placeholder="Select a user"
              showSearch
              optionFilterProp="label"
              options={userOptions}
            />
          </Form.Item>

          <Form.Item label="Enabled" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Typography.Text strong style={{ display: 'block', marginBottom: 12, marginTop: 8 }}>
            Platform Configuration
          </Typography.Text>

          {renderPlatformConfig(channelType, 'edit')}
        </Form>
      </Modal>

      {/* Post-Create Success Modal */}
      <Modal
        title={null}
        open={createdChannelKey !== null}
        footer={[
          <Button
            key="done"
            type="primary"
            onClick={() => {
              setCreatedChannelKey(null);
              setCreatedChannelType(null);
            }}
          >
            Done
          </Button>,
        ]}
        onCancel={() => {
          setCreatedChannelKey(null);
          setCreatedChannelType(null);
        }}
        width={560}
      >
        <Result
          status="success"
          title="Channel Created"
          subTitle="Your gateway channel has been created. Use the channel key below to configure your platform integration."
        />
        {createdChannelKey && createdChannelKey !== 'pending' && (
          <div style={{ padding: '0 24px 16px' }}>
            <Alert
              message="Channel Key"
              description={
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Input.Search
                    value={createdChannelKey}
                    readOnly
                    enterButton={<CopyOutlined />}
                    onSearch={() => handleCopyKey(createdChannelKey)}
                    style={{ fontFamily: 'monospace' }}
                  />
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    Keep this key secret — it authenticates messages from the platform to Agor.
                  </Typography.Text>
                </Space>
              }
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
            />
            {createdChannelType === 'slack' && (
              <Alert
                message="Slack Setup"
                description={
                  <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
                    <li>Install the Slack app to your workspace</li>
                    <li>Enable Socket Mode in your Slack app settings</li>
                    <li>
                      Subscribe to events: message.channels, message.groups, message.im, app_mention
                    </li>
                    <li>The gateway will automatically connect when the channel is enabled</li>
                  </ol>
                }
                type="info"
                showIcon
              />
            )}
          </div>
        )}
        {createdChannelKey === 'pending' && (
          <div style={{ padding: '0 24px 16px' }}>
            <Alert
              message="Channel key will appear here after the server processes the request."
              type="info"
              showIcon
            />
          </div>
        )}
      </Modal>
    </div>
  );
};
