/**
 * CardModal - Detail view for a card on the board.
 *
 * Opens when clicking a card. Shows:
 * - Title + URL link
 * - Metadata (type, board, zone)
 * - Note (editable)
 * - Description (editable)
 * - Data (collapsed JSON viewer)
 * - Archive/Delete/Save actions
 */

import type { AgorClient, Board, CardWithType } from '@agor-live/client';
import {
  DeleteOutlined,
  EditOutlined,
  InboxOutlined,
  LinkOutlined,
  PushpinFilled,
  SaveOutlined,
} from '@ant-design/icons';
import { Button, Collapse, Input, Modal, Space, Tag, Typography, theme } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useThemedMessage } from '../../utils/message';
import { MarkdownRenderer } from '../MarkdownRenderer';

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

const { TextArea } = Input;

interface CardModalProps {
  open: boolean;
  card: CardWithType | null;
  board?: Board | null;
  zoneName?: string;
  zoneColor?: string;
  client: AgorClient | null;
  onClose: () => void;
  onCardUpdated?: (card: CardWithType) => void;
  onCardDeleted?: (cardId: string) => void;
}

const CardModalComponent = ({
  open,
  card,
  board,
  zoneName,
  zoneColor,
  client,
  onClose,
  onCardUpdated,
  onCardDeleted,
}: CardModalProps) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();

  // Edit state
  const [editingNote, setEditingNote] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [noteValue, setNoteValue] = useState('');
  const [descValue, setDescValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Sync local state when card changes
  useEffect(() => {
    if (card) {
      setNoteValue(card.note || '');
      setDescValue(card.description || '');
      setEditingNote(false);
      setEditingDesc(false);
    }
  }, [card]);

  const hasChanges = noteValue !== (card?.note || '') || descValue !== (card?.description || '');

  const handleSave = useCallback(async () => {
    if (!card || !client || !hasChanges) return;
    setSaving(true);
    try {
      const updated = await client.service('cards').patch(card.card_id, {
        note: noteValue,
        description: descValue,
      });
      onCardUpdated?.(updated as CardWithType);
      setEditingNote(false);
      setEditingDesc(false);
      showSuccess('Card saved');
    } catch (err) {
      console.error('Failed to save card:', err);
      showError('Failed to save card');
    } finally {
      setSaving(false);
    }
  }, [card, client, noteValue, descValue, hasChanges, onCardUpdated, showSuccess, showError]);

  const handleArchive = useCallback(async () => {
    if (!card || !client) return;
    try {
      const updated = await client.service('cards').patch(card.card_id, {
        archived: true,
        archived_at: new Date().toISOString(),
      });
      onCardUpdated?.(updated as CardWithType);
      onClose();
      showSuccess('Card archived');
    } catch (err) {
      console.error('Failed to archive card:', err);
      showError('Failed to archive card');
    }
  }, [card, client, onCardUpdated, onClose, showSuccess, showError]);

  const handleDelete = useCallback(async () => {
    if (!card || !client) return;
    Modal.confirm({
      title: 'Delete card?',
      content: `This will permanently delete "${card.title}".`,
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        try {
          await client.service('cards').remove(card.card_id);
          onCardDeleted?.(card.card_id);
          onClose();
          showSuccess('Card deleted');
        } catch (err) {
          console.error('Failed to delete card:', err);
          showError('Failed to delete card');
        }
      },
    });
  }, [card, client, onCardDeleted, onClose, showSuccess, showError]);

  if (!card) return null;

  const emoji = card.effective_emoji;
  const borderColor = card.effective_color || token.colorBorder;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={560}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Space>
            <Button icon={<InboxOutlined />} onClick={handleArchive}>
              Archive
            </Button>
            <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>
              Delete
            </Button>
          </Space>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            disabled={!hasChanges}
            loading={saving}
          >
            Save
          </Button>
        </div>
      }
      title={null}
      styles={{
        body: { padding: 0 },
      }}
    >
      {/* Title bar */}
      <div
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          borderLeft: `4px solid ${borderColor}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        {emoji && <span style={{ fontSize: 20 }}>{emoji}</span>}
        <Typography.Title level={5} style={{ margin: 0, flex: 1 }}>
          {card.title}
        </Typography.Title>
        {card.url && isSafeUrl(card.url) && (
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: token.colorLink }}
          >
            Open <LinkOutlined />
          </a>
        )}
      </div>

      {/* Metadata */}
      <div
        style={{
          padding: '12px 24px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        {card.card_type && (
          <Tag>
            {card.card_type.emoji && `${card.card_type.emoji} `}
            {card.card_type.name}
          </Tag>
        )}
        {board && (
          <Tag>
            {board.icon ? `${board.icon} ` : ''}
            {board.name}
          </Tag>
        )}
        {zoneName && (
          <Tag icon={<PushpinFilled style={zoneColor ? { color: zoneColor } : undefined} />}>
            {zoneName}
          </Tag>
        )}
      </div>

      {/* Note section */}
      <div
        style={{ padding: '12px 24px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <Typography.Text strong style={{ fontSize: 12, color: token.colorTextSecondary }}>
            Note
          </Typography.Text>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => setEditingNote(!editingNote)}
          >
            {editingNote ? 'Preview' : 'Edit'}
          </Button>
        </div>
        {editingNote ? (
          <TextArea
            value={noteValue}
            onChange={(e) => setNoteValue(e.target.value)}
            placeholder="Agent's live commentary..."
            autoSize={{ minRows: 2, maxRows: 8 }}
            style={{ background: token.colorFillQuaternary }}
          />
        ) : noteValue ? (
          <div
            style={{
              background: token.colorFillQuaternary,
              borderRadius: token.borderRadiusSM,
              padding: '8px 12px',
            }}
          >
            <MarkdownRenderer content={noteValue} compact showControls={false} />
          </div>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12, fontStyle: 'italic' }}>
            No note
          </Typography.Text>
        )}
      </div>

      {/* Description section */}
      <div
        style={{ padding: '12px 24px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <Typography.Text strong style={{ fontSize: 12, color: token.colorTextSecondary }}>
            Description
          </Typography.Text>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => setEditingDesc(!editingDesc)}
          >
            {editingDesc ? 'Preview' : 'Edit'}
          </Button>
        </div>
        {editingDesc ? (
          <TextArea
            value={descValue}
            onChange={(e) => setDescValue(e.target.value)}
            placeholder="Stable context about this entity..."
            autoSize={{ minRows: 3, maxRows: 12 }}
          />
        ) : descValue ? (
          <MarkdownRenderer content={descValue} compact showControls={false} />
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12, fontStyle: 'italic' }}>
            No description
          </Typography.Text>
        )}
      </div>

      {/* Data section (collapsed JSON) */}
      {card.data && Object.keys(card.data).length > 0 && (
        <div style={{ padding: '0 24px 12px' }}>
          <Collapse
            ghost
            items={[
              {
                key: 'data',
                label: (
                  <Typography.Text strong style={{ fontSize: 12, color: token.colorTextSecondary }}>
                    Data
                  </Typography.Text>
                ),
                children: (
                  <pre
                    style={{
                      background: token.colorFillQuaternary,
                      borderRadius: token.borderRadiusSM,
                      padding: '8px 12px',
                      fontSize: 11,
                      overflow: 'auto',
                      maxHeight: 300,
                      margin: 0,
                    }}
                  >
                    {JSON.stringify(card.data, null, 2)}
                  </pre>
                ),
              },
            ]}
          />
        </div>
      )}

      {/* Footer metadata */}
      <div
        style={{
          padding: '8px 24px 12px',
          color: token.colorTextTertiary,
          fontSize: 11,
        }}
      >
        {card.created_by && `Created by: ${card.created_by}`}
        {card.created_at && ` • ${new Date(card.created_at).toLocaleString()}`}
      </div>
    </Modal>
  );
};

const CardModal = React.memo(CardModalComponent);

export default CardModal;
