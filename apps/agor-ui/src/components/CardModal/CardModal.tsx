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

import type {
  AgorClient,
  Board,
  CardWithType,
  EffectiveCapabilityPolicyAccess,
} from '@agor-live/client';
import {
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  PushpinFilled,
  SaveOutlined,
} from '@ant-design/icons';
import {
  Button,
  Collapse,
  Input,
  Modal,
  type ModalFuncProps,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useBoardMutationGuard } from '../../hooks/useBoardMutationGuard';
import { useAgorStore } from '../../store/agorStore';
import type { BoardWriteTicket } from '../../store/boardMutationGuard';
import { selectBranchById } from '../../store/selectors';
import { formatActionError } from '../../utils/connectionErrors';
import { useThemedMessage } from '../../utils/message';
import { isSafeExternalUrl } from '../../utils/safeExternalUrl';
import { ArchiveActionButton } from '../ArchiveButton';
import { getBoardEmoji } from '../BoardTile';
import { MarkdownRenderer } from '../MarkdownRenderer';

const { TextArea } = Input;

interface CardModalProps {
  open: boolean;
  card: CardWithType | null;
  board?: Board | null;
  zoneName?: string;
  zoneColor?: string;
  client: AgorClient | null;
  onClose: () => void;
  afterClose?: () => void;
  onCardUpdated?: (card: CardWithType) => void;
  onCardDeleted?: (cardId: string) => void;
  /**
   * Edits are blocked for this reason (e.g. the card's board is still
   * loading, so the card shown may be stale).
   */
  readOnlyReason?: string;
  /**
   * The card shows its board's partition data (the canvas): edits need the
   * partition loaded, and a reload while the modal is open makes it read-only.
   */
  requireLoadedBoard?: boolean;
}

const CardModalComponent = ({
  open,
  card,
  board,
  zoneName,
  zoneColor,
  client,
  onClose,
  afterClose,
  onCardUpdated,
  onCardDeleted,
  readOnlyReason,
  requireLoadedBoard = false,
}: CardModalProps) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const branchById = useAgorStore(selectBranchById);
  const boardEmoji = board ? getBoardEmoji(board, branchById) : undefined;

  // Edit state
  const [editingNote, setEditingNote] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [noteValue, setNoteValue] = useState('');
  const [descValue, setDescValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [boardAccess, setBoardAccess] = useState<EffectiveCapabilityPolicyAccess | null>(null);

  // Sync local state when card changes
  useEffect(() => {
    if (card) {
      setNoteValue(card.note || '');
      setDescValue(card.description || '');
      setEditingNote(false);
      setEditingDesc(false);
    }
  }, [card]);

  // Mirrors the daemon's card-mutation check (`cardAccess('mutate', ...)`),
  // which resolves to the same `board.edit` capability as the board itself.
  // A card list is already scoped to boards the caller can VIEW, which is a
  // weaker guarantee than being able to edit them.
  const boardId = board?.board_id;
  useEffect(() => {
    if (!open || !client || !boardId) {
      setBoardAccess(null);
      return;
    }
    let cancelled = false;
    client
      .service('boards/:id/effective-access')
      .find({ route: { id: boardId } })
      .then((access: unknown) => {
        if (!cancelled) setBoardAccess(access as EffectiveCapabilityPolicyAccess);
      })
      .catch(() => {
        if (!cancelled) setBoardAccess(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client, boardId]);

  // The board write guard (`useBoardMutationGuard`). The ticket is captured
  // when the modal opens on a card; every write, including those confirmed in
  // a dialog, checks it immediately before dispatching. A board reload or a
  // lost connection while the modal is open ends it: reopen to edit.
  const guard = useBoardMutationGuard(boardId, true, { requirePartition: requireLoadedBoard });
  const [ticket, setTicket] = useState<BoardWriteTicket | null>(null);
  // The ticket of the card open now. The guard outlives a close (the modal
  // stays mounted), so closing, switching cards or unmounting ends the
  // open-time ticket here, in the commit that does it.
  const openTicketRef = useRef<BoardWriteTicket | null>(null);
  // Confirmations are static dialogs outside this tree; they belong to this
  // modal on this card, so closing it, switching cards or unmounting destroys
  // every one still open.
  const confirmsRef = useRef(new Set<{ destroy: () => void }>());
  const cardId = card?.card_id;
  // Captured after the commit, once the connection snapshot is published.
  // biome-ignore lint/correctness/useExhaustiveDependencies: captured on open, per card
  useEffect(() => {
    const captured = open && cardId ? guard.capture() : null;
    openTicketRef.current = captured;
    setTicket(captured);
  }, [open, cardId]);
  // Ended in the commit that closes the card, before anything can run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: torn down per open card
  useLayoutEffect(
    () => () => {
      openTicketRef.current = null;
      for (const confirm of confirmsRef.current) confirm.destroy();
      confirmsRef.current.clear();
    },
    [open, cardId]
  );
  const ticketCurrent = guard.isCurrent(ticket);
  const isOpenTicketCurrent = useCallback(
    (held: BoardWriteTicket | null) =>
      held !== null && held === openTicketRef.current && guard.isCurrent(held),
    [guard]
  );

  // One confirmation at a time: a second click (or the other action) while
  // one is open opens nothing. The set is updated synchronously, so a double
  // click can't slip a second dialog in before a render.
  const openConfirm = useCallback((config: ModalFuncProps) => {
    if (confirmsRef.current.size > 0) return;
    const confirm = Modal.confirm({
      ...config,
      afterClose: () => {
        confirmsRef.current.delete(confirm);
      },
    });
    confirmsRef.current.add(confirm);
  }, []);

  const hasEditAccess = Boolean(boardAccess?.capabilities.includes('board.edit'));
  const canEdit = !readOnlyReason && hasEditAccess && ticketCurrent;
  const editBlockedReason = canEdit
    ? undefined
    : (readOnlyReason ??
      (!hasEditAccess
        ? "You don't have Board Editor or Manager access to change this card."
        : !guard.canMutate
          ? 'This board is unavailable for edits right now.'
          : 'This board reloaded while the card was open. Reopen it to edit.'));

  const hasChanges = noteValue !== (card?.note || '') || descValue !== (card?.description || '');

  const handleSave = useCallback(async () => {
    if (!card || !client || !hasChanges || !canEdit || !isOpenTicketCurrent(ticket)) return;
    setSaving(true);
    try {
      const updated = await client.service('cards').patch(card.card_id, {
        note: noteValue,
        description: descValue,
      });
      onCardUpdated?.(updated as CardWithType);
      setEditingNote(false);
      setEditingDesc(false);
      showSuccess('Card saved.');
    } catch (err) {
      showError(formatActionError('save the card', err, { idempotent: true }));
    } finally {
      setSaving(false);
    }
  }, [
    card,
    client,
    noteValue,
    descValue,
    hasChanges,
    canEdit,
    isOpenTicketCurrent,
    ticket,
    onCardUpdated,
    showSuccess,
    showError,
  ]);

  const handleArchive = useCallback(async () => {
    if (!card || !client || !canEdit) return;
    openConfirm({
      title: 'Archive card?',
      content: `This will hide "${card.title}" from the board while preserving its data.`,
      okText: 'Archive',
      onOk: async () => {
        // The board may have reloaded, or the connection dropped, while the
        // confirmation was open.
        if (!isOpenTicketCurrent(ticket)) {
          guard.warnDropped(
            "Couldn't archive the card, because the board reloaded or the connection dropped."
          );
          return;
        }
        try {
          const updated = await client.service('cards').patch(card.card_id, {
            archived: true,
            archived_at: new Date().toISOString(),
          });
          onCardUpdated?.(updated as CardWithType);
          onClose();
          showSuccess('Card archived.');
        } catch (err) {
          showError(formatActionError('archive the card', err, { idempotent: true }));
        }
      },
    });
  }, [
    card,
    client,
    canEdit,
    guard,
    ticket,
    isOpenTicketCurrent,
    openConfirm,
    onCardUpdated,
    onClose,
    showSuccess,
    showError,
  ]);

  const handleDelete = useCallback(async () => {
    if (!card || !client || !canEdit) return;
    openConfirm({
      title: 'Delete card?',
      content: `This will permanently delete "${card.title}".`,
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        if (!isOpenTicketCurrent(ticket)) {
          guard.warnDropped(
            "Couldn't delete the card, because the board reloaded or the connection dropped."
          );
          return;
        }
        try {
          await client.service('cards').remove(card.card_id);
          onCardDeleted?.(card.card_id);
          onClose();
          showSuccess('Card deleted.');
        } catch (err) {
          showError(formatActionError('delete the card', err, { idempotent: true }));
        }
      },
    });
  }, [
    card,
    client,
    canEdit,
    guard,
    ticket,
    isOpenTicketCurrent,
    openConfirm,
    onCardDeleted,
    onClose,
    showSuccess,
    showError,
  ]);

  if (!card) return null;

  const emoji = card.effective_emoji;
  const borderColor = card.effective_color || token.colorBorder;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      afterClose={afterClose}
      width={560}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Space>
            <ArchiveActionButton
              tooltip={editBlockedReason ?? ''}
              size="middle"
              disabled={!canEdit}
              onClick={handleArchive}
            >
              Archive
            </ArchiveActionButton>
            {/* A disabled button can't host a tooltip of its own — hence the span. */}
            <Tooltip title={editBlockedReason}>
              <span>
                <Button danger icon={<DeleteOutlined />} disabled={!canEdit} onClick={handleDelete}>
                  Delete
                </Button>
              </span>
            </Tooltip>
          </Space>
          <Tooltip title={editBlockedReason}>
            <span>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                onClick={handleSave}
                disabled={!hasChanges || !canEdit}
                loading={saving}
              >
                Save
              </Button>
            </span>
          </Tooltip>
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
        {isSafeExternalUrl(card.url) && (
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
            {boardEmoji ? `${boardEmoji} ` : ''}
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
          <Tooltip title={editBlockedReason}>
            <span>
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                disabled={!canEdit}
                onClick={() => setEditingNote(!editingNote)}
              >
                {editingNote ? 'Preview' : 'Edit'}
              </Button>
            </span>
          </Tooltip>
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
          <Tooltip title={editBlockedReason}>
            <span>
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                disabled={!canEdit}
                onClick={() => setEditingDesc(!editingDesc)}
              >
                {editingDesc ? 'Preview' : 'Edit'}
              </Button>
            </span>
          </Tooltip>
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
