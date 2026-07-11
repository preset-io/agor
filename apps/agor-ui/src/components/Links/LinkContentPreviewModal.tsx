import { Alert, Modal, Spin, Typography, theme } from 'antd';
import React from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  fetchLinkImageObjectUrl,
  fetchLinkMarkdownText,
  getSafeLinkContentLabel,
  type LinkContentTarget,
  type LinkPreviewKind,
} from './linkContent';
import styles from './linkUi.module.css';

export type LinkPreviewTarget = LinkContentTarget;

interface LinkContentPreviewModalProps {
  target: LinkPreviewTarget | null;
  kind: LinkPreviewKind;
  onClose: () => void;
}

type LoadedPreview =
  | { kind: 'image'; value: string }
  | { kind: 'markdown' | 'text'; value: string };

export const LinkContentPreviewModal: React.FC<LinkContentPreviewModalProps> = ({
  target,
  kind,
  onClose,
}) => {
  const { token } = theme.useToken();
  const [loaded, setLoaded] = React.useState<LoadedPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const safeSubtitle = getSafeLinkContentLabel(target?.subtitle);

  React.useEffect(() => {
    if (!target) {
      setLoaded(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setLoaded(null);
    setError(null);
    setLoading(true);

    const request =
      kind === 'image'
        ? fetchLinkImageObjectUrl(target.linkId, controller.signal).then((value) => {
            if (cancelled) {
              URL.revokeObjectURL(value);
              throw new DOMException('Preview request aborted', 'AbortError');
            }
            objectUrl = value;
            return { kind: 'image' as const, value };
          })
        : fetchLinkMarkdownText(target.linkId, controller.signal).then((value) => ({
            kind,
            value,
          }));

    request
      .then((value) => {
        if (!cancelled) setLoaded(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Preview failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, target]);

  const image = loaded?.kind === 'image' ? loaded.value : null;
  const text = loaded && loaded.kind !== 'image' ? loaded.value : null;

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
          <Typography.Text className={styles.previewSubtitle} type="secondary" ellipsis>
            {safeSubtitle}
          </Typography.Text>
        )}
        {loading && (
          <div
            className={`${styles.previewCenter} ${
              kind === 'image' ? styles.imagePreviewLoading : styles.markdownPreviewLoading
            }`}
          >
            <Spin tip={`Loading ${kind === 'image' ? 'image' : 'text'} preview…`} />
          </div>
        )}
        {error && <Alert type="warning" showIcon message={error} />}
        {image && !error && (
          <div
            className={styles.previewSurface}
            style={{
              background: token.colorFillQuaternary,
              borderRadius: token.borderRadiusLG,
              padding: token.paddingSM,
            }}
          >
            <img
              className={styles.previewImage}
              data-testid="link-image-preview-image"
              src={image}
              alt={target?.title ?? 'Uploaded image preview'}
            />
          </div>
        )}
        {text &&
          !error &&
          (loaded?.kind === 'text' ? (
            <pre className={styles.plainTextPreview}>{text}</pre>
          ) : (
            <MarkdownRenderer content={text} />
          ))}
      </div>
    </Modal>
  );
};
