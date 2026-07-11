import {
  CloseOutlined,
  ExclamationOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { Alert, Button, Modal, Space, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import type { ComposerAttachment } from './composerAttachments';

function getFileIcon(file: File) {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) return FilePdfOutlined;
  if (type.startsWith('text/') || name.endsWith('.md') || name.endsWith('.markdown')) {
    return FileTextOutlined;
  }
  return FileOutlined;
}

interface SessionAttachmentTrayProps {
  attachments: ComposerAttachment[];
  disabled?: boolean;
  onRemove: (id: string) => void;
}

export const SessionAttachmentTray: React.FC<SessionAttachmentTrayProps> = ({
  attachments,
  disabled = false,
  onRemove,
}) => {
  const { token } = theme.useToken();
  const [previewAttachmentId, setPreviewAttachmentId] = React.useState<string | null>(null);

  if (attachments.length === 0) return null;

  const failedCount = attachments.filter((attachment) => attachment.status === 'failed').length;
  const previewAttachment =
    attachments.find((attachment) => attachment.id === previewAttachmentId) ?? null;

  return (
    <>
      <Space orientation="vertical" style={{ width: '100%' }} size={6}>
        {disabled && (
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Sending prompt. Attachment changes are locked until sending finishes.
          </Typography.Text>
        )}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: token.paddingSM }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: token.paddingSM, flex: 1 }}>
            {attachments.map((attachment) => {
              const isUploading = attachment.status === 'uploading';
              const isFailed = attachment.status === 'failed';
              const isImage = Boolean(attachment.previewUrl);
              const FileIcon = getFileIcon(attachment.file);
              return (
                <div
                  key={attachment.id}
                  style={{
                    position: 'relative',
                    width: 96,
                    height: 72,
                    borderRadius: token.borderRadiusLG,
                    overflow: 'visible',
                    border: `1px solid ${isFailed ? token.colorError : token.colorBorderSecondary}`,
                    background: token.colorBgLayout,
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Preview ${attachment.file.name}`}
                    onClick={() => setPreviewAttachmentId(attachment.id)}
                    style={{
                      width: '100%',
                      height: '100%',
                      padding: 0,
                      border: 0,
                      borderRadius: token.borderRadiusLG,
                      background: 'transparent',
                      cursor: 'zoom-in',
                      display: 'block',
                    }}
                  >
                    {isImage ? (
                      <img
                        src={attachment.previewUrl}
                        alt={attachment.file.name}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: 'block',
                          borderRadius: token.borderRadiusLG,
                          opacity: isUploading || isFailed ? 0.42 : 1,
                        }}
                      />
                    ) : (
                      <div
                        role="img"
                        aria-label={attachment.file.name}
                        style={{
                          width: '100%',
                          height: '100%',
                          borderRadius: token.borderRadiusLG,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexDirection: 'column',
                          gap: 4,
                          color: token.colorTextSecondary,
                          opacity: isUploading || isFailed ? 0.42 : 1,
                          padding: token.paddingXS,
                        }}
                      >
                        <FileIcon style={{ fontSize: 26 }} />
                        <Typography.Text
                          ellipsis
                          style={{ maxWidth: 78, fontSize: token.fontSizeSM }}
                        >
                          {attachment.file.name}
                        </Typography.Text>
                      </div>
                    )}
                    {(isUploading || isFailed) && (
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexDirection: 'column',
                          gap: 2,
                          color: isFailed ? token.colorError : token.colorPrimary,
                          fontSize: token.fontSizeSM,
                          fontWeight: 600,
                          pointerEvents: 'none',
                        }}
                      >
                        {isUploading ? (
                          <LoadingOutlined style={{ fontSize: 24 }} />
                        ) : (
                          <ExclamationOutlined />
                        )}
                        <span>{isUploading ? 'Uploading' : 'Failed'}</span>
                      </div>
                    )}
                  </button>
                  <Tooltip title={disabled ? 'Sending prompt…' : 'Remove file'}>
                    <Button
                      aria-label={`Remove ${attachment.file.name}`}
                      icon={<CloseOutlined />}
                      shape="circle"
                      size="small"
                      onClick={() => onRemove(attachment.id)}
                      disabled={disabled}
                      style={{
                        position: 'absolute',
                        top: -8,
                        left: -8,
                        zIndex: 2,
                        background: token.colorBgElevated,
                      }}
                    />
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </div>
        {failedCount > 0 && (
          <Alert
            type="error"
            showIcon
            message={`${failedCount} file${failedCount === 1 ? '' : 's'} failed or cannot be uploaded. Remove failed files before sending.`}
            style={{ paddingBlock: token.paddingXXS }}
          />
        )}
      </Space>
      {previewAttachment && (
        <Modal
          open
          title={`Preview ${previewAttachment.file.name}`}
          footer={null}
          centered
          width={720}
          onCancel={() => setPreviewAttachmentId(null)}
        >
          {previewAttachment.previewUrl ? (
            <img
              src={previewAttachment.previewUrl}
              alt={`Preview of ${previewAttachment.file.name}`}
              style={{
                display: 'block',
                maxWidth: '100%',
                maxHeight: '70vh',
                margin: '0 auto',
                objectFit: 'contain',
              }}
            />
          ) : (
            <Space direction="vertical" align="center" style={{ width: '100%', padding: 24 }}>
              {React.createElement(getFileIcon(previewAttachment.file), {
                style: { fontSize: 48 },
              })}
              <Typography.Text strong>{previewAttachment.file.name}</Typography.Text>
              <Typography.Text type="secondary">
                {previewAttachment.file.type || 'Unknown file type'}
              </Typography.Text>
            </Space>
          )}
        </Modal>
      )}
    </>
  );
};
