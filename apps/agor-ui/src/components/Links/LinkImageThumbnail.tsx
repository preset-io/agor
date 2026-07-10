import { FileImageOutlined } from '@ant-design/icons';
import { Spin, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import type { LinkImagePreviewTarget } from './LinkImagePreviewModal';
import { fetchLinkImageObjectUrl, getSafeLinkContentLabel } from './linkContent';

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
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const [shouldLoad, setShouldLoad] = React.useState(
    () => typeof IntersectionObserver === 'undefined'
  );
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (shouldLoad) return;
    const node = buttonRef.current;
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
    <button
      ref={buttonRef}
      type="button"
      aria-label={`Open image preview for ${title}`}
      onClick={handleOpen}
      style={{
        display: 'block',
        width: 260,
        maxWidth: '100%',
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
          width: '100%',
          height: 146,
          maxWidth: '100%',
          display: 'grid',
          placeItems: 'center',
          background: token.colorFillQuaternary,
        }}
      >
        {objectUrl && !failed ? (
          <img
            src={objectUrl}
            alt={title}
            decoding="async"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={() => setFailed(true)}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: token.sizeXS,
              color: token.colorTextTertiary,
            }}
          >
            {loading ? <Spin size="small" /> : <FileImageOutlined style={{ fontSize: 28 }} />}
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {loading ? 'Loading preview…' : 'Click to preview'}
            </Typography.Text>
          </div>
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
