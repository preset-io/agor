import { Alert, Modal, Spin, Typography, theme } from 'antd';
import React from 'react';
import {
  fetchLinkImageObjectUrl,
  getSafeLinkContentLabel,
  type LinkContentTarget,
} from './linkContent';

export type LinkImagePreviewTarget = LinkContentTarget;

interface LinkImagePreviewModalProps {
  target: LinkImagePreviewTarget | null;
  onClose: () => void;
}

export const LinkImagePreviewModal: React.FC<LinkImagePreviewModalProps> = ({
  target,
  onClose,
}) => {
  const { token } = theme.useToken();
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const safeSubtitle = getSafeLinkContentLabel(target?.subtitle);

  React.useEffect(() => {
    if (!target) {
      setObjectUrl(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true);
    setError(null);
    setObjectUrl(null);

    const controller = new AbortController();

    fetchLinkImageObjectUrl(target.linkId, controller.signal)
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
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [target]);

  return (
    <Modal
      open={Boolean(target)}
      title={target?.title ?? 'Image preview'}
      onCancel={onClose}
      footer={null}
      width="min(960px, 92vw)"
      destroyOnHidden
    >
      <div data-testid="link-image-preview-modal">
        {safeSubtitle && (
          <Typography.Text type="secondary" ellipsis style={{ display: 'block', marginBottom: 12 }}>
            {safeSubtitle}
          </Typography.Text>
        )}
        {loading && (
          <div style={{ display: 'grid', placeItems: 'center', minHeight: 260 }}>
            <Spin tip="Loading image preview…" />
          </div>
        )}
        {error && <Alert type="warning" showIcon message={error} />}
        {objectUrl && !error && (
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              background: token.colorFillQuaternary,
              borderRadius: token.borderRadiusLG,
              padding: token.paddingSM,
              maxHeight: '72vh',
              overflow: 'auto',
            }}
          >
            <img
              data-testid="link-image-preview-image"
              src={objectUrl}
              alt={target?.title ?? 'Uploaded image preview'}
              style={{ maxWidth: '100%', maxHeight: '68vh', objectFit: 'contain' }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
};
