import { FileImageOutlined } from '@ant-design/icons';
import { Button, Flex, Spin, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import type { LinkPreviewTarget } from './LinkContentPreviewModal';
import { getSafeLinkContentLabel } from './linkContent';
import { useLinkPreviewResource } from './useLinkPreviewResource';

interface LinkImageThumbnailProps {
  linkId: string;
  title: string;
  subtitle?: string | null;
  onOpen: (target: LinkPreviewTarget) => void;
}

export const LinkImageThumbnail: React.FC<LinkImageThumbnailProps> = ({
  linkId,
  title,
  subtitle,
  onOpen,
}) => {
  const { token } = theme.useToken();
  const safeSubtitle = getSafeLinkContentLabel(subtitle);
  const thumbnailRef = React.useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = React.useState(
    () => typeof IntersectionObserver === 'undefined'
  );
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (shouldLoad) return;
    const node = thumbnailRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: '240px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shouldLoad]);

  const { resource, error, loading } = useLinkPreviewResource(linkId, 'image', shouldLoad);
  const objectUrl = resource?.value;
  const failed = Boolean(error || (objectUrl && failedUrl === objectUrl));

  const handleOpen = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen({ linkId, title, subtitle: safeSubtitle });
  };

  return (
    <div ref={thumbnailRef} style={{ marginTop: token.sizeUnit }}>
      <Button
        type="text"
        aria-label={`Open image preview for ${title}`}
        onClick={handleOpen}
        style={{
          display: 'block',
          height: 'auto',
          width: 260,
          maxWidth: '100%',
          padding: 0,
          overflow: 'hidden',
          font: 'inherit',
          textAlign: 'left',
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          background: token.colorBgContainer,
          cursor: 'zoom-in',
          color: token.colorText,
        }}
      >
        <span
          style={{
            display: 'grid',
            width: '100%',
            maxWidth: '100%',
            height: 146,
            placeItems: 'center',
            background: token.colorFillQuaternary,
          }}
        >
          {objectUrl && !failed ? (
            <img
              src={objectUrl}
              alt={title}
              decoding="async"
              onError={() => setFailedUrl(objectUrl ?? null)}
              style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <Flex
              component="span"
              vertical
              align="center"
              gap="small"
              style={{ color: token.colorTextTertiary }}
            >
              {loading ? (
                <Spin size="small" />
              ) : (
                <FileImageOutlined style={{ fontSize: token.fontSizeHeading2 }} />
              )}
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {loading ? 'Loading preview…' : 'Click to preview'}
              </Typography.Text>
            </Flex>
          )}
        </span>
        <Tooltip title={safeSubtitle || title} mouseEnterDelay={0.6}>
          <Flex
            component="span"
            align="center"
            gap="small"
            style={{ minWidth: 0, padding: `${token.paddingXXS}px ${token.paddingXS}px` }}
          >
            <FileImageOutlined style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
            <Typography.Text ellipsis style={{ maxWidth: 230, fontSize: token.fontSizeSM }}>
              {title}
            </Typography.Text>
          </Flex>
        </Tooltip>
      </Button>
    </div>
  );
};
