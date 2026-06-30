import { CloseOutlined, LoadingOutlined } from '@ant-design/icons';
import { Tooltip, Typography, theme } from 'antd';
import type React from 'react';

const { Text } = Typography;

/**
 * An image pasted into the composer and attached inline (no upload modal).
 * Uploaded to the session immediately on paste; `path` is filled in once the
 * upload resolves and is what gets appended to the outgoing prompt as a mention.
 */
export interface PendingImageAttachment {
  /** Stable client-side id (also used to revoke the preview URL). */
  id: string;
  /** Display name (the generated `pasted-screenshot-*.png`). */
  name: string;
  /** Local object URL for the thumbnail preview. */
  previewUrl: string;
  /** Server upload path; present once `status === 'done'`. */
  path?: string;
  status: 'uploading' | 'done';
}

interface PendingAttachmentsProps {
  attachments: PendingImageAttachment[];
  onRemove: (id: string) => void;
}

/**
 * Compact inline thumbnail chips for images pasted into the prompt composer.
 * Renders nothing when there are no attachments.
 */
export const PendingAttachments: React.FC<PendingAttachmentsProps> = ({
  attachments,
  onRemove,
}) => {
  const { token } = theme.useToken();

  if (attachments.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: token.sizeUnit * 2,
        marginBottom: token.sizeUnit * 2,
      }}
      data-testid="pending-attachments"
    >
      {attachments.map((att) => (
        <div
          key={att.id}
          style={{
            position: 'relative',
            width: 56,
            height: 56,
            borderRadius: token.borderRadius,
            border: `1px solid ${token.colorBorder}`,
            overflow: 'hidden',
            background: token.colorFillQuaternary,
            flexShrink: 0,
          }}
          title={att.name}
        >
          <img
            src={att.previewUrl}
            alt={att.name}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              opacity: att.status === 'uploading' ? 0.5 : 1,
            }}
          />

          {att.status === 'uploading' && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <LoadingOutlined style={{ color: token.colorPrimary, fontSize: 18 }} />
            </div>
          )}

          <Tooltip title="Remove">
            <button
              type="button"
              aria-label={`Remove ${att.name}`}
              onClick={() => onRemove(att.id)}
              style={{
                position: 'absolute',
                top: 2,
                right: 2,
                width: 18,
                height: 18,
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                borderRadius: '50%',
                cursor: 'pointer',
                color: token.colorWhite,
                background: 'rgba(0, 0, 0, 0.55)',
                lineHeight: 1,
              }}
            >
              <CloseOutlined style={{ fontSize: 10 }} />
            </button>
          </Tooltip>
        </div>
      ))}

      <Text
        type="secondary"
        style={{ fontSize: token.fontSizeSM, alignSelf: 'center' }}
        aria-hidden="true"
      >
        {attachments.some((a) => a.status === 'uploading') ? 'Uploading…' : ''}
      </Text>
    </div>
  );
};
