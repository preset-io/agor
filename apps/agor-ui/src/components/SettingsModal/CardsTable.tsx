import type {
  AgorClient,
  Board,
  BoardEntityObject,
  CardType,
  CardWithType,
} from '@agor-live/client';
import { DeleteOutlined, EditOutlined, PlusOutlined, PushpinFilled } from '@ant-design/icons';
import {
  Button,
  ColorPicker,
  Empty,
  Flex,
  Form,
  Input,
  Layout,
  List,
  Modal,
  Popconfirm,
  Space,
  Table,
  Typography,
  theme,
} from 'antd';
import { useMemo, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import CardModal from '../CardModal/CardModal';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import { JSONEditor, validateJSON } from '../JSONEditor';

const { Sider, Content } = Layout;

interface CardsTableProps {
  client: AgorClient | null;
  cardById: Map<string, CardWithType>;
  cardTypeById: Map<string, CardType>;
  boardById: Map<string, Board>;
  boardObjects?: BoardEntityObject[];
}

export const CardsTable: React.FC<CardsTableProps> = ({
  client,
  cardById,
  cardTypeById,
  boardById,
  boardObjects,
}) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();

  // State
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [createTypeModalOpen, setCreateTypeModalOpen] = useState(false);
  const [editTypeModalOpen, setEditTypeModalOpen] = useState(false);
  const [editingType, setEditingType] = useState<CardType | null>(null);
  const [cardModalCard, setCardModalCard] = useState<CardWithType | null>(null);
  const [form] = Form.useForm();

  // Derived data
  const cardTypes = useMemo(
    () => mapToArray(cardTypeById).sort((a, b) => a.name.localeCompare(b.name)),
    [cardTypeById]
  );

  // Build card_id → zone info lookup from board_objects
  const cardZoneInfo = useMemo(() => {
    const map = new Map<string, { zoneName: string; zoneColor?: string }>();
    if (!boardObjects) return map;
    for (const bo of boardObjects) {
      if (!bo.card_id || !bo.zone_id) continue;
      const board = boardById.get(bo.board_id);
      const zoneObj = board?.objects?.[bo.zone_id];
      if (zoneObj && zoneObj.type === 'zone') {
        map.set(bo.card_id, {
          zoneName: zoneObj.label || 'Unknown Zone',
          zoneColor: zoneObj.borderColor || zoneObj.color,
        });
      }
    }
    return map;
  }, [boardObjects, boardById]);

  const selectedType = selectedTypeId ? (cardTypeById.get(selectedTypeId) ?? null) : null;

  const cardsForType = useMemo(() => {
    if (!selectedTypeId) return [];
    return mapToArray(cardById)
      .filter((c) => c.card_type_id === selectedTypeId && !c.archived)
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [cardById, selectedTypeId]);

  // Card type CRUD handlers
  const handleCreateType = async () => {
    if (!client) return;
    try {
      const values = await form.validateFields();
      const colorValue =
        typeof values.color === 'string'
          ? values.color
          : (values.color?.toHexString?.() ?? undefined);
      await client.service('card-types').create({
        name: values.name,
        emoji: values.emoji || undefined,
        color: colorValue || undefined,
        json_schema: values.json_schema ? JSON.parse(values.json_schema) : undefined,
      });
      form.resetFields();
      setCreateTypeModalOpen(false);
      showSuccess('Card type created');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return; // validation error
      console.error('Failed to create card type:', err);
      showError('Failed to create card type');
    }
  };

  const handleUpdateType = async () => {
    if (!client || !editingType) return;
    try {
      const values = await form.validateFields();
      const colorValue =
        typeof values.color === 'string'
          ? values.color
          : (values.color?.toHexString?.() ?? undefined);
      await client.service('card-types').patch(editingType.card_type_id, {
        name: values.name,
        emoji: values.emoji || undefined,
        color: colorValue || undefined,
        json_schema: values.json_schema ? JSON.parse(values.json_schema) : undefined,
      });
      form.resetFields();
      setEditTypeModalOpen(false);
      setEditingType(null);
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
      if (selectedTypeId === cardTypeId) setSelectedTypeId(null);
      showSuccess('Card type deleted');
    } catch (err) {
      console.error('Failed to delete card type:', err);
      showError('Failed to delete card type');
    }
  };

  const openEditType = (ct: CardType) => {
    setEditingType(ct);
    form.setFieldsValue({
      name: ct.name,
      emoji: ct.emoji,
      color: ct.color,
      json_schema: ct.json_schema ? JSON.stringify(ct.json_schema, null, 2) : '',
    });
    setEditTypeModalOpen(true);
  };

  // Card table columns
  const cardColumns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, record: CardWithType) => (
        <Space>
          {record.effective_emoji && <span>{record.effective_emoji}</span>}
          <Typography.Text>{title}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Board',
      dataIndex: 'board_id',
      key: 'board',
      width: 180,
      render: (boardId: string) => {
        const board = boardById.get(boardId);
        return (
          <Typography.Text type="secondary">
            {board ? `${board.icon ? `${board.icon} ` : ''}${board.name}` : '—'}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Zone',
      key: 'zone',
      width: 180,
      render: (_: unknown, record: CardWithType) => {
        const info = cardZoneInfo.get(record.card_id);
        if (!info) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Space size={4}>
            {info.zoneColor && <PushpinFilled style={{ color: info.zoneColor, fontSize: 12 }} />}
            <Typography.Text style={{ fontSize: 13 }}>{info.zoneName}</Typography.Text>
          </Space>
        );
      },
    },
  ];

  // Card modal helpers
  const cardModalBoard = cardModalCard ? (boardById.get(cardModalCard.board_id) ?? null) : null;

  const handleCardUpdated = (updated: CardWithType) => {
    setCardModalCard(updated);
  };

  const handleCardDeleted = (_cardId: string) => {
    setCardModalCard(null);
  };

  // Type form content (shared between create and edit modals)
  const typeFormContent = (
    <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
      <Form.Item label="Name" style={{ marginBottom: 24 }}>
        <Flex gap={8}>
          <Form.Item name="emoji" noStyle>
            <FormEmojiPickerInput form={form} fieldName="emoji" defaultEmoji="📋" />
          </Form.Item>
          <Form.Item name="name" noStyle rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Support Ticket" style={{ flex: 1 }} />
          </Form.Item>
        </Flex>
      </Form.Item>
      <Form.Item name="color" label="Color">
        <ColorPicker showText format="hex" allowClear />
      </Form.Item>
      <Form.Item
        name="json_schema"
        label="JSON Schema (optional)"
        help="Define a JSON Schema to validate card data"
        rules={[{ validator: validateJSON }]}
      >
        <JSONEditor placeholder='{"type": "object", "properties": {...}}' rows={4} />
      </Form.Item>
    </Form>
  );

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
        <Space>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Cards
          </Typography.Title>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '1px 6px',
              borderRadius: 4,
              background: token.colorWarningBg,
              color: token.colorWarningText,
              border: `1px solid ${token.colorWarningBorder}`,
            }}
          >
            Beta
          </span>
        </Space>
        <Typography.Text type="secondary">
          Manage card types and view cards across all boards
        </Typography.Text>
      </div>

      <Layout
        style={{
          background: 'transparent',
          height: 'calc(100% - 60px)',
          minHeight: 400,
        }}
      >
        {/* Column 1: Card Types sidebar */}
        <Sider
          width={260}
          style={{
            background: token.colorBgElevated,
            borderRadius: token.borderRadiusLG,
            border: `1px solid ${token.colorBorderSecondary}`,
            overflow: 'auto',
            marginRight: 16,
          }}
        >
          <div
            style={{
              padding: '12px 16px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Typography.Text strong>Card Types</Typography.Text>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => {
                form.resetFields();
                setCreateTypeModalOpen(true);
              }}
            >
              New
            </Button>
          </div>
          {cardTypes.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No card types yet" />
            </div>
          ) : (
            <List
              dataSource={cardTypes}
              split={false}
              renderItem={(ct) => (
                <List.Item
                  key={ct.card_type_id}
                  onClick={() => setSelectedTypeId(ct.card_type_id)}
                  style={{
                    padding: '8px 16px',
                    cursor: 'pointer',
                    background:
                      selectedTypeId === ct.card_type_id ? token.colorBgTextHover : 'transparent',
                    borderLeft:
                      selectedTypeId === ct.card_type_id
                        ? `3px solid ${ct.color || token.colorPrimary}`
                        : '3px solid transparent',
                  }}
                  actions={[
                    <Button
                      key="edit"
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditType(ct);
                      }}
                    />,
                    <Popconfirm
                      key="delete"
                      title="Delete card type?"
                      description="Cards using this type will become untyped."
                      onConfirm={(e) => {
                        e?.stopPropagation();
                        handleDeleteType(ct.card_type_id);
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<DeleteOutlined />}
                        danger
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    avatar={<span style={{ fontSize: 18 }}>{ct.emoji || '📋'}</span>}
                    title={
                      <Typography.Text style={{ fontSize: 13 }} ellipsis>
                        {ct.name}
                      </Typography.Text>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </Sider>

        {/* Column 2: Cards for selected type */}
        <Content style={{ minWidth: 0 }}>
          {selectedType ? (
            <div>
              <div style={{ marginBottom: 12 }}>
                <Space>
                  <span style={{ fontSize: 20 }}>{selectedType.emoji || '📋'}</span>
                  <Typography.Title level={5} style={{ margin: 0 }}>
                    {selectedType.name}
                  </Typography.Title>
                  <Typography.Text type="secondary">
                    ({cardsForType.length} card{cardsForType.length !== 1 ? 's' : ''})
                  </Typography.Text>
                </Space>
              </div>
              <Table
                dataSource={cardsForType}
                columns={cardColumns}
                rowKey="card_id"
                size="small"
                pagination={{ pageSize: 20, hideOnSinglePage: true }}
                onRow={(record) => ({
                  onClick: () => setCardModalCard(record),
                  style: { cursor: 'pointer' },
                })}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="No cards of this type yet"
                    />
                  ),
                }}
              />
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                minHeight: 300,
              }}
            >
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  cardTypes.length === 0
                    ? 'Create a card type to get started'
                    : 'Select a card type to view its cards'
                }
              />
            </div>
          )}
        </Content>
      </Layout>

      {/* Create CardType Modal */}
      <Modal
        title="Create Card Type"
        open={createTypeModalOpen}
        onOk={handleCreateType}
        onCancel={() => {
          form.resetFields();
          setCreateTypeModalOpen(false);
        }}
        okText="Create"
      >
        {typeFormContent}
      </Modal>

      {/* Edit CardType Modal */}
      <Modal
        title="Edit Card Type"
        open={editTypeModalOpen}
        onOk={handleUpdateType}
        onCancel={() => {
          form.resetFields();
          setEditTypeModalOpen(false);
          setEditingType(null);
        }}
        okText="Save"
      >
        {typeFormContent}
      </Modal>

      {/* Card Detail Modal (reuse Phase 2 component) */}
      <CardModal
        open={!!cardModalCard}
        card={cardModalCard}
        board={cardModalBoard}
        client={client}
        onClose={() => setCardModalCard(null)}
        onCardUpdated={handleCardUpdated}
        onCardDeleted={handleCardDeleted}
      />
    </div>
  );
};
