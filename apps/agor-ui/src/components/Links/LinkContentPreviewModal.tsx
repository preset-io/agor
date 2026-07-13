import { Alert, Modal, Spin, Typography, theme } from 'antd';
import type React from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  getSafeLinkContentLabel,
  type LinkContentTarget,
  type LinkPreviewKind,
} from './linkContent';
import { useLinkPreviewResource } from './useLinkPreviewResource';

export type LinkPreviewTarget = LinkContentTarget;

interface LinkContentPreviewModalProps {
  target: LinkPreviewTarget | null;
  kind: LinkPreviewKind;
  onClose: () => void;
}

export const LinkContentPreviewModal: React.FC<LinkContentPreviewModalProps> = ({
  target,
  kind,
  onClose,
}) => {
  const { token } = theme.useToken();
  const safeSubtitle = getSafeLinkContentLabel(target?.subtitle);
  const { resource, error, loading } = useLinkPreviewResource(target?.linkId, kind);
  const image = resource?.kind === 'image' ? resource.value : null;
  const text = resource && resource.kind !== 'image' ? resource.value : null;

  return (
    <Modal
      open={Boolean(target)}
      title={target?.title ?? (kind === 'image' ? 'Image preview' : 'Text preview')}
      onCancel={onClose}
      footer={null}
      width={kind === 'image' ? 'min(960px, 92vw)' : 900}
      destroyOnHidden
      styles={
        kind === 'image'
          ? undefined
          : { body: { maxHeight: '70vh', overflowY: 'auto', padding: token.paddingLG } }
      }
    >
      <div data-testid="link-content-preview-modal">
        {safeSubtitle && (
          <Typography.Text
            type="secondary"
            ellipsis
            style={{ display: 'block', marginBottom: token.marginSM }}
          >
            {safeSubtitle}
          </Typography.Text>
        )}
        {loading && (
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              minHeight: kind === 'image' ? 260 : 220,
            }}
          >
            <Spin tip={`Loading ${kind === 'image' ? 'image' : 'text'} preview…`} />
          </div>
        )}
        {error && <Alert type="warning" showIcon message={error} />}
        {image && !error && (
          <div
            style={{
              display: 'grid',
              maxHeight: '72vh',
              overflow: 'auto',
              placeItems: 'center',
              background: token.colorFillQuaternary,
              borderRadius: token.borderRadiusLG,
              padding: token.paddingSM,
            }}
          >
            <img
              data-testid="link-image-preview-image"
              src={image}
              alt={target?.title ?? 'Uploaded image preview'}
              style={{ maxWidth: '100%', maxHeight: '68vh', objectFit: 'contain' }}
            />
          </div>
        )}
        {text &&
          !error &&
          (resource?.kind === 'text' ? (
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</pre>
          ) : (
            <MarkdownRenderer content={text} />
          ))}
      </div>
    </Modal>
  );
};
