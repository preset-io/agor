import type { BoardObject } from '@agor-live/client';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { App, Button, Card, Space, Typography, theme } from 'antd';
import { useLayoutEffect, useRef } from 'react';
import { useMutationGate } from '../../../contexts/ConnectionContext';
import type { BoardWriteTicket } from '../../../store/boardMutationGuard';
import { MarkdownRenderer } from '../../MarkdownRenderer/MarkdownRenderer';

interface MarkdownNodeData {
  objectId: string;
  content: string;
  width: number;
  canEdit: boolean;
  onUpdate: (id: string, data: BoardObject) => void;
  onEdit?: (objectId: string, content: string, width: number) => void;
  /** `ticket`: captured when the confirmation opened (`null` is refused). */
  onDelete?: (objectId: string, ticket: BoardWriteTicket | null) => void;
  /** Capture the board write ticket when a confirmation opens. */
  beginBoardWrite?: () => BoardWriteTicket | null;
}

export const MarkdownNode = ({ data }: { data: MarkdownNodeData }) => {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const mutationGate = useMutationGate();
  const mutationDisabled = !mutationGate.canMutate || !data.canEdit;
  // The confirmation belongs to this node: removing the node destroys it, in
  // the commit that removes it. One at a time: tracked synchronously, so a
  // double click can't open a second one before a render.
  const confirmsRef = useRef(new Set<{ destroy: () => void }>());
  useLayoutEffect(() => {
    const confirms = confirmsRef.current;
    return () => {
      for (const confirm of confirms) confirm.destroy();
      confirms.clear();
    };
  }, []);

  const handleEdit = () => {
    if (mutationDisabled) return;
    // Trigger edit by calling the onEdit callback if provided
    if (data.onEdit) {
      data.onEdit(data.objectId, data.content, data.width);
    }
  };

  const handleDelete = () => {
    if (mutationDisabled || !data.onDelete || confirmsRef.current.size > 0) return;
    // A board reload while the confirmation is open drops the delete. A node
    // without a ticket source has no ticket: its delete is refused, never
    // captured afresh at OK.
    const ticket = data.beginBoardWrite?.() ?? null;

    const confirm = modal.confirm({
      title: 'Delete note?',
      content: 'This note will be removed from the board.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => data.onDelete?.(data.objectId, ticket),
      afterClose: () => {
        confirmsRef.current.delete(confirm);
      },
    });
    confirmsRef.current.add(confirm);
  };

  return (
    <Card
      style={{
        width: data.width,
        minHeight: 100,
        background: token.colorBgContainer,
        border: `2px solid ${token.colorBorder}`,
        borderRadius: 8,
        boxShadow: token.boxShadowSecondary,
        cursor: 'move',
      }}
      size="small"
      title={
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Markdown Note
          </Typography.Text>
          <Space size={2}>
            <Button
              className="nodrag nopan"
              type="text"
              size="small"
              icon={<EditOutlined />}
              aria-label="Edit note"
              onClick={(e) => {
                e.stopPropagation();
                handleEdit();
              }}
              disabled={mutationDisabled}
              title="Edit note"
            />
            <Button
              className="nodrag nopan"
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              aria-label="Delete note"
              onClick={(e) => {
                e.stopPropagation();
                handleDelete();
              }}
              disabled={mutationDisabled}
              title="Delete note"
            />
          </Space>
        </div>
      }
      styles={{ body: { padding: token.sizeUnit * 8 } }}
    >
      <div
        className="markdown-content"
        style={{
          fontSize: token.fontSize,
          color: token.colorText,
          lineHeight: 1.6,
        }}
      >
        <MarkdownRenderer content={data.content} />
      </div>
    </Card>
  );
};
