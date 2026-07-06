import { FileImageOutlined } from '@ant-design/icons';
import { Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import type { LinkImagePreviewTarget } from './LinkImagePreviewModal';
import { getSafeLinkContentLabel } from './linkContent';

interface LinkImageThumbnailProps {
  linkId: string;
  title: string;
  subtitle?: string | null;
  onOpen: (target: LinkImagePreviewTarget) => void;
}

export const LinkImageThumbnail: React.FC<LinkImageThumbnailProps> = ({
  linkId,
  title,
  subtitle,
  onOpen,
}) => {
  const { token } = theme.useToken();
  const safeSubtitle = getSafeLinkContentLabel(subtitle);

  const handleOpen = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen({ linkId, title, subtitle: safeSubtitle });
  };

  return (
    <button
      type="button"
      aria-label={`Open image preview for ${title}`}
      onClick={handleOpen}
      style={{
        display: 'block',
        width: 'fit-content',
        maxWidth: 320,
        marginTop: token.sizeUnit,
        padding: 0,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer,
        overflow: 'hidden',
        cursor: 'zoom-in',
        color: token.colorText,
        font: 'inherit',
        textAlign: 'left',
      }}
    >
      <div
        style={{
          width: 260,
          minHeight: 120,
          maxHeight: 180,
          display: 'grid',
          placeItems: 'center',
          background: token.colorFillQuaternary,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: token.sizeXS,
            color: token.colorTextTertiary,
          }}
        >
          <FileImageOutlined style={{ fontSize: 28 }} />
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Click to preview
          </Typography.Text>
        </div>
      </div>
      <Tooltip title={safeSubtitle || title} mouseEnterDelay={0.6}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: token.sizeXS,
            padding: `${token.paddingXXS}px ${token.paddingXS}px`,
          }}
        >
          <FileImageOutlined style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
          <Typography.Text ellipsis style={{ maxWidth: 230, fontSize: token.fontSizeSM }}>
            {title}
          </Typography.Text>
        </div>
      </Tooltip>
    </button>
  );
};
