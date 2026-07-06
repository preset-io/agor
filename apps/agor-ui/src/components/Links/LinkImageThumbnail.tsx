import { FileImageOutlined } from '@ant-design/icons';
import { Alert, Spin, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { fetchLinkImageObjectUrl, type LinkImagePreviewTarget } from './LinkImagePreviewModal';
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
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true);
    setError(null);
    setObjectUrl(null);

    fetchLinkImageObjectUrl(linkId)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setObjectUrl(url);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Preview failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [linkId]);

  const safeSubtitle = getSafeLinkContentLabel(subtitle);

  const handleOpen = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!objectUrl || error) return;
    onOpen({ linkId, title, subtitle: safeSubtitle });
  };

  return (
    <button
      type="button"
      disabled={!objectUrl || Boolean(error)}
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
        cursor: objectUrl && !error ? 'zoom-in' : 'default',
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
        {loading && <Spin size="small" />}
        {error && (
          <Alert
            type="warning"
            showIcon
            message="Preview unavailable"
            description={error}
            style={{ margin: token.marginXS, maxWidth: 240 }}
          />
        )}
        {objectUrl && !error && (
          <img
            src={objectUrl}
            alt={title}
            style={{
              display: 'block',
              maxWidth: 320,
              maxHeight: 180,
              width: 'auto',
              height: 'auto',
              objectFit: 'contain',
            }}
          />
        )}
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
