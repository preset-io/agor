import { FileImageOutlined } from '@ant-design/icons';
import { Button, Flex, Spin, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import type { LinkImagePreviewTarget } from './LinkImagePreviewModal';
import { fetchLinkImageObjectUrl, getSafeLinkContentLabel } from './linkContent';
import styles from './linkUi.module.css';

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
  const thumbnailRef = React.useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = React.useState(
    () => typeof IntersectionObserver === 'undefined'
  );
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

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

  React.useEffect(() => {
    if (!shouldLoad) return;

    const controller = new AbortController();
    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true);
    setFailed(false);
    setObjectUrl(null);

    fetchLinkImageObjectUrl(linkId, controller.signal)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setObjectUrl(url);
      })
      .catch((error) => {
        if (!cancelled && !(error instanceof Error && error.name === 'AbortError')) {
          setFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [linkId, shouldLoad]);

  const handleOpen = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen({ linkId, title, subtitle: safeSubtitle });
  };

  return (
    <div ref={thumbnailRef} style={{ marginTop: token.sizeUnit }}>
      <Button
        className={styles.thumbnailButton}
        type="text"
        aria-label={`Open image preview for ${title}`}
        onClick={handleOpen}
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          background: token.colorBgContainer,
          cursor: 'zoom-in',
          color: token.colorText,
        }}
      >
        <span className={styles.thumbnailCanvas} style={{ background: token.colorFillQuaternary }}>
          {objectUrl && !failed ? (
            <img
              className={styles.thumbnailImage}
              src={objectUrl}
              alt={title}
              decoding="async"
              onError={() => setFailed(true)}
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
            className={styles.thumbnailFooter}
            align="center"
            gap="small"
            style={{ padding: `${token.paddingXXS}px ${token.paddingXS}px` }}
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
