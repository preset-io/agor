import type { BoardObject } from '@agor/core/types';
import { EditOutlined } from '@ant-design/icons';
import { Button, Card, Typography, theme } from 'antd';
import { useState } from 'react';
import { MarkdownRenderer } from '../../MarkdownRenderer/MarkdownRenderer';

interface MarkdownNodeData {
  objectId: string;
  content: string;
  width: number;
  onUpdate: (id: string, data: BoardObject) => void;
  onEdit?: (objectId: string, content: string, width: number) => void;
}

export const MarkdownNode = ({ data }: { data: MarkdownNodeData }) => {
  const { token } = theme.useToken();

  const handleEdit = () => {
    // Trigger edit by calling the onEdit callback if provided
    if (data.onEdit) {
      data.onEdit(data.objectId, data.content, data.width);
    }
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
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={e => {
              e.stopPropagation();
              handleEdit();
            }}
            title="Edit note"
          />
        </div>
      }
      bodyStyle={{ padding: token.sizeUnit * 8 }}
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
