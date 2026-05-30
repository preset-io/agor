import type { BoardObject } from '@agor-live/client';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { App, Button, Card, Space, Typography, theme } from 'antd';
import { useMutationGate } from '../../../contexts/ConnectionContext';
import { MarkdownRenderer } from '../../MarkdownRenderer/MarkdownRenderer';

interface MarkdownNodeData {
  objectId: string;
  content: string;
  width: number;
  onUpdate: (id: string, data: BoardObject) => void;
  onEdit?: (objectId: string, content: string, width: number) => void;
  onDelete?: (objectId: string) => void;
}

export const MarkdownNode = ({ data }: { data: MarkdownNodeData }) => {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const mutationGate = useMutationGate();
  const mutationDisabled = !mutationGate.canMutate;

  const handleEdit = () => {
    if (mutationDisabled) return;
    // Trigger edit by calling the onEdit callback if provided
    if (data.onEdit) {
      data.onEdit(data.objectId, data.content, data.width);
    }
  };

  const handleDelete = () => {
    if (mutationDisabled || !data.onDelete) return;

    modal.confirm({
      title: 'Delete note?',
      content: 'This note will be removed from the board.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => data.onDelete?.(data.objectId),
    });
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
