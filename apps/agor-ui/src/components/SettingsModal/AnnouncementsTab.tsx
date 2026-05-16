import type { AgorClient } from '@agor-live/client';
import { PlusOutlined, WarningOutlined } from '@ant-design/icons';
import {
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  message,
  Space,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { formatAbsoluteTime, formatRelativeTime } from '../../utils/time';

const { Text } = Typography;
const { TextArea } = Input;

interface BroadcastSummary {
  broadcast_group_id: string;
  title: string;
  preview?: string;
  banner: boolean;
  created_at: string;
  expires_at?: string;
  recipient_count: number;
  source_user_id?: string;
}

export interface AnnouncementsTabProps {
  client: AgorClient | null;
}

/**
 * Admin "Announcements" tab — compose, list, and expire global broadcasts.
 *
 * Routes used (all admin-gated server-side):
 * - GET  /notifications/listBroadcasts  → list active + recent
 * - POST /notifications/broadcast       → create
 * - POST /notifications/expireBroadcast → expire now
 */
export const AnnouncementsTab: React.FC<AnnouncementsTabProps> = ({ client }) => {
  const { token } = theme.useToken();
  const [broadcasts, setBroadcasts] = useState<BroadcastSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);

  const refetch = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic feathers service typing
      const list = await (client.service('notifications') as any).listBroadcasts();
      setBroadcasts(Array.isArray(list) ? list : []);
    } catch (err) {
      console.warn('[announcements] failed to list:', err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const handleExpire = useCallback(
    async (groupId: string) => {
      if (!client) return;
      try {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic feathers service typing
        await (client.service('notifications') as any).expireBroadcast({
          broadcast_group_id: groupId,
        });
        message.success('Announcement expired');
        refetch();
      } catch (err) {
        message.error(`Failed to expire: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [client, refetch]
  );

  const now = Date.now();
  const isActive = (b: BroadcastSummary) => {
    if (!b.expires_at) return true;
    return new Date(b.expires_at).getTime() > now;
  };
  const active = broadcasts.filter(isActive);
  const past = broadcasts.filter((b) => !isActive(b));

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: token.marginLG,
        }}
      >
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Announcements
          </Typography.Title>
          <Text type="secondary">
            Broadcast a message to every user. Optionally pin it as a sticky banner.
          </Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setComposeOpen(true)}>
          New announcement
        </Button>
      </div>

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Active
      </Typography.Title>
      <Table<BroadcastSummary>
        rowKey="broadcast_group_id"
        dataSource={active}
        loading={loading}
        pagination={false}
        locale={{ emptyText: 'No active announcements.' }}
        columns={[
          {
            title: 'Title',
            dataIndex: 'title',
            render: (title: string, record) => (
              <Space>
                {record.banner && <WarningOutlined style={{ color: token.colorWarning }} />}
                <span>{title}</span>
              </Space>
            ),
          },
          {
            title: 'Preview',
            dataIndex: 'preview',
            render: (preview?: string) => (preview ? <Text type="secondary">{preview}</Text> : '—'),
          },
          {
            title: 'Banner',
            dataIndex: 'banner',
            width: 80,
            render: (banner: boolean) =>
              banner ? <Tag color="orange">Banner</Tag> : <Tag>Panel only</Tag>,
          },
          {
            title: 'Recipients',
            dataIndex: 'recipient_count',
            width: 110,
          },
          {
            title: 'Sent',
            dataIndex: 'created_at',
            width: 130,
            render: (v: string) => (
              <span title={formatAbsoluteTime(v)}>{formatRelativeTime(v)}</span>
            ),
          },
          {
            title: 'Expires',
            dataIndex: 'expires_at',
            width: 140,
            render: (v?: string) =>
              v ? <span title={formatAbsoluteTime(v)}>{formatRelativeTime(v)}</span> : 'Never',
          },
          {
            title: '',
            key: 'actions',
            width: 100,
            render: (_: unknown, record) => (
              <Button danger size="small" onClick={() => handleExpire(record.broadcast_group_id)}>
                Expire now
              </Button>
            ),
          },
        ]}
      />

      {past.length > 0 && (
        <>
          <Typography.Title level={5} style={{ marginTop: token.marginXL }}>
            Past
          </Typography.Title>
          <Table<BroadcastSummary>
            rowKey="broadcast_group_id"
            dataSource={past}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: 'Title', dataIndex: 'title' },
              {
                title: 'Sent',
                dataIndex: 'created_at',
                width: 160,
                render: (v: string) => (
                  <span title={formatAbsoluteTime(v)}>{formatRelativeTime(v)}</span>
                ),
              },
              {
                title: 'Expired',
                dataIndex: 'expires_at',
                width: 160,
                render: (v?: string) =>
                  v ? <span title={formatAbsoluteTime(v)}>{formatRelativeTime(v)}</span> : '—',
              },
              { title: 'Recipients', dataIndex: 'recipient_count', width: 110 },
            ]}
          />
        </>
      )}

      <ComposeAnnouncementModal
        open={composeOpen}
        client={client}
        onClose={() => setComposeOpen(false)}
        onSent={() => {
          setComposeOpen(false);
          refetch();
        }}
      />
    </div>
  );
};

// ============================================================================
// Compose modal
// ============================================================================

interface ComposeAnnouncementModalProps {
  open: boolean;
  client: AgorClient | null;
  onClose: () => void;
  onSent: () => void;
}

interface ComposeForm {
  title: string;
  preview?: string;
  banner: boolean;
  expireValue?: number;
  expireUnit?: 'minutes' | 'hours' | 'days';
}

const ComposeAnnouncementModal: React.FC<ComposeAnnouncementModalProps> = ({
  open,
  client,
  onClose,
  onSent,
}) => {
  const [form] = Form.useForm<ComposeForm>();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!client) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const expires_at = computeExpiresAt(values);
      // biome-ignore lint/suspicious/noExplicitAny: dynamic feathers service typing
      await (client.service('notifications') as any).broadcast({
        title: values.title,
        preview: values.preview,
        banner: values.banner ?? false,
        expires_at: expires_at?.toISOString(),
      });
      message.success('Announcement sent');
      form.resetFields();
      onSent();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        // Form validation failed — antd already surfaces field errors.
        return;
      }
      message.error(`Failed to send: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="New announcement"
      onCancel={onClose}
      onOk={handleSubmit}
      okText="Send to all"
      okButtonProps={{ loading: submitting }}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ banner: false, expireUnit: 'hours' }}
        preserve={false}
      >
        <Form.Item
          name="title"
          label="Title"
          rules={[
            { required: true, message: 'Title is required' },
            { max: 80, message: 'Keep titles under 80 characters' },
          ]}
        >
          <Input placeholder="e.g. Deploying around noon PST today" />
        </Form.Item>

        <Form.Item
          name="preview"
          label="Preview"
          rules={[{ max: 160, message: 'Keep previews under 160 characters' }]}
        >
          <TextArea
            placeholder="Optional longer description (~160 chars)"
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
        </Form.Item>

        <Form.Item name="banner" valuePropName="checked">
          <Checkbox>Show as a sticky banner in the navbar</Checkbox>
        </Form.Item>

        <Form.Item label="Auto-expire after">
          <Space>
            <Form.Item name="expireValue" noStyle>
              <InputNumber min={1} placeholder="(never)" style={{ width: 100 }} />
            </Form.Item>
            <Form.Item name="expireUnit" noStyle>
              <Input style={{ width: 100 }} placeholder="hours" disabled={false} />
            </Form.Item>
            <Text type="secondary">(blank = never expires)</Text>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
};

function computeExpiresAt(values: ComposeForm): Date | undefined {
  if (!values.expireValue || values.expireValue <= 0) return undefined;
  const ms = unitToMs(values.expireUnit ?? 'hours') * values.expireValue;
  return new Date(Date.now() + ms);
}

function unitToMs(unit: 'minutes' | 'hours' | 'days' | string): number {
  switch (unit) {
    case 'minutes':
      return 60_000;
    case 'days':
      return 86_400_000;
    case 'hours':
    default:
      return 3_600_000;
  }
}
