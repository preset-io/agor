import type { AgorClient, CardType } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, ExportOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  ColorPicker,
  Empty,
  Flex,
  Form,
  Input,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import { useSettingsRoute } from '@/hooks/useSettingsRoute';
import { mapToArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import { HighlightMatch } from '../HighlightMatch';
import { validateJSON } from '../JSONEditor';
import { CardTypeSchemaEditor } from './CardTypeSchemaEditor';
import { ListPanelHeader } from './panelPrimitives';
import { SettingsActionGroup } from './SettingsActionGroup';
import { DrillInFrame, useSettingsDrill } from './SettingsDrill';

interface CardTypesPanelProps {
  client: AgorClient | null;
  cardTypeById: Map<string, CardType>;
}

const schemaFieldCount = (ct: CardType): number =>
  Object.keys(
    (ct.json_schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
  ).length;

export const CardTypesPanel: React.FC<CardTypesPanelProps> = ({ client, cardTypeById }) => {
  const { showSuccess, showError } = useThemedMessage();
  const { drill, openDrill, closeDrill } = useSettingsDrill();
  const { openSettings } = useSettingsRoute();
  const [searchTerm, setSearchTerm] = useState('');
  const [typeDirty, setTypeDirty] = useState(false);
  const [form] = Form.useForm();

  const editingType =
    drill?.kind === 'cards' && drill.mode === 'edit' && drill.recordId
      ? (cardTypeById.get(drill.recordId) ?? null)
      : null;
  const isCreatingType = drill?.kind === 'cards' && drill.mode === 'create';

  const cardTypes = useMemo(
    () => mapToArray(cardTypeById).sort((a, b) => a.name.localeCompare(b.name)),
    [cardTypeById]
  );

  const filteredCardTypes = useMemo(
    () =>
      filterBySettingsSearch(cardTypes, searchTerm, [
        (cardType) => cardType.name,
        (cardType) => cardType.emoji,
        (cardType) => JSON.stringify(cardType.json_schema ?? {}),
      ]),
    [cardTypes, searchTerm]
  );

  const buildSchema = (raw: string | undefined) => (raw?.trim() ? JSON.parse(raw) : undefined);

  const colorFromValue = (value: unknown): string | undefined =>
    typeof value === 'string'
      ? value
      : ((value as { toHexString?: () => string } | undefined)?.toHexString?.() ?? undefined);

  const handleCreateType = async () => {
    if (!client) return;
    try {
      const values = await form.validateFields();
      await client.service('card-types').create({
        name: values.name,
        emoji: values.emoji || undefined,
        color: colorFromValue(values.color) || undefined,
        json_schema: buildSchema(values.json_schema),
      });
      setTypeDirty(false);
      closeDrill();
      showSuccess('Card type created');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      console.error('Failed to create card type:', err);
      showError('Failed to create card type');
    }
  };

  const handleUpdateType = async () => {
    if (!client || !editingType) return;
    try {
      const values = await form.validateFields();
      await client.service('card-types').patch(editingType.card_type_id, {
        name: values.name,
        emoji: values.emoji || undefined,
        color: colorFromValue(values.color) || undefined,
        json_schema: buildSchema(values.json_schema),
      });
      setTypeDirty(false);
      closeDrill();
      showSuccess('Card type updated');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      console.error('Failed to update card type:', err);
      showError('Failed to update card type');
    }
  };

  const handleDeleteType = async (cardTypeId: string) => {
    if (!client) return;
    try {
      await client.service('card-types').remove(cardTypeId);
      showSuccess('Card type deleted');
    } catch (err) {
      console.error('Failed to delete card type:', err);
      showError('Failed to delete card type');
    }
  };

  const openEditType = (ct: CardType) => {
    form.setFieldsValue({
      name: ct.name,
      emoji: ct.emoji,
      color: ct.color,
      json_schema: ct.json_schema ? JSON.stringify(ct.json_schema, null, 2) : '',
    });
    setTypeDirty(false);
    openDrill({ kind: 'cards', mode: 'edit', recordId: ct.card_type_id });
  };

  const openCreateType = () => {
    form.resetFields();
    setTypeDirty(false);
    openDrill({ kind: 'cards', mode: 'create' });
  };

  const columns = [
    {
      title: 'Type',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, ct: CardType) => (
        <Space>
          <span style={{ fontSize: 18 }}>{ct.emoji || '📋'}</span>
          <Typography.Link ellipsis title={name} onClick={() => openEditType(ct)}>
            <HighlightMatch text={name} query={searchTerm} />
          </Typography.Link>
          {ct.color && <Tag color={ct.color}>{ct.color}</Tag>}
        </Space>
      ),
    },
    {
      title: 'Fields',
      key: 'fields',
      width: 120,
      render: (_: unknown, ct: CardType) => {
        const count = schemaFieldCount(ct);
        return count > 0 ? (
          <Typography.Text type="secondary">
            {count} field{count === 1 ? '' : 's'}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_: unknown, ct: CardType) => (
        <SettingsActionGroup>
          <Tooltip title="View cards of this type">
            <Button
              type="text"
              size="small"
              icon={<ExportOutlined />}
              onClick={() => openSettings('cards', ct.card_type_id)}
            />
          </Tooltip>
          <Tooltip title="Edit card type">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEditType(ct)}
            />
          </Tooltip>
          <Popconfirm
            title="Delete card type?"
            description="Cards using this type will become untyped."
            onConfirm={() => handleDeleteType(ct.card_type_id)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </SettingsActionGroup>
      ),
    },
  ];

  if (isCreatingType || editingType) {
    return (
      <DrillInFrame
        title={editingType ? 'Edit Card Type' : 'Create Card Type'}
        dirty={typeDirty}
        saveLabel={editingType ? 'Save' : 'Create'}
        onSave={editingType ? handleUpdateType : handleCreateType}
      >
        <Form
          form={form}
          layout="vertical"
          style={{ maxWidth: 520 }}
          onValuesChange={() => setTypeDirty(true)}
        >
          <Form.Item label="Name" style={{ marginBottom: 24 }}>
            <Flex gap={8}>
              <Form.Item name="emoji" noStyle>
                <FormEmojiPickerInput fieldName="emoji" defaultEmoji="📋" />
              </Form.Item>
              <Form.Item
                name="name"
                noStyle
                rules={[{ required: true, message: 'Name is required' }]}
              >
                <Input placeholder="e.g. Support Ticket" style={{ flex: 1 }} />
              </Form.Item>
            </Flex>
          </Form.Item>
          <Form.Item name="color" label="Color">
            <ColorPicker showText format="hex" allowClear />
          </Form.Item>
          <Form.Item
            name="json_schema"
            label="Data schema (optional)"
            rules={[{ validator: validateJSON }]}
          >
            <CardTypeSchemaEditor key={editingType?.card_type_id ?? 'new'} />
          </Form.Item>
        </Form>
      </DrillInFrame>
    );
  }

  return (
    <div>
      <ListPanelHeader
        title="Card Types"
        description="Define reusable card types with an optional data schema."
        search={
          <Input
            allowClear
            placeholder="Search card types"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: 300 }}
          />
        }
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={openCreateType}
            disabled={!client}
          >
            New Type
          </Button>
        }
      />

      {cardTypes.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 300,
          }}
        >
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No card types yet" />
        </div>
      ) : (
        <Table
          dataSource={filteredCardTypes}
          columns={columns}
          rowKey="card_type_id"
          size="small"
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      )}
    </div>
  );
};
