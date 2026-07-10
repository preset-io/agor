import { Alert, Modal, Spin, Typography } from 'antd';
import React from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  fetchLinkMarkdownText,
  getSafeLinkContentLabel,
  type LinkContentTarget,
} from './linkContent';
import styles from './linkUi.module.css';

export type LinkMarkdownPreviewTarget = LinkContentTarget;

interface LinkMarkdownPreviewModalProps {
  target: LinkMarkdownPreviewTarget | null;
  onClose: () => void;
  plainText?: boolean;
}

export const LinkMarkdownPreviewModal: React.FC<LinkMarkdownPreviewModalProps> = ({
  target,
  onClose,
  plainText = false,
}) => {
  const [content, setContent] = React.useState<string>('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const safeSubtitle = getSafeLinkContentLabel(target?.subtitle);

  React.useEffect(() => {
    if (!target) {
      setContent('');
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent('');

    fetchLinkMarkdownText(target.linkId)
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Preview failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  return (
    <Modal
      open={Boolean(target)}
      title={target?.title ?? 'Markdown preview'}
      onCancel={onClose}
      footer={null}
      width={900}
      destroyOnHidden
      styles={{
        body: {
          maxHeight: '70vh',
          overflowY: 'auto',
          padding: 24,
        },
      }}
    >
      <div data-testid="link-markdown-preview-modal">
        {safeSubtitle && (
          <Typography.Text className={styles.previewSubtitle} type="secondary" ellipsis>
            {safeSubtitle}
          </Typography.Text>
        )}
        {loading && (
          <div className={`${styles.previewCenter} ${styles.markdownPreviewLoading}`}>
            <Spin tip="Loading markdown preview…" />
          </div>
        )}
        {error && <Alert type="warning" showIcon message={error} />}
        {!loading &&
          !error &&
          content &&
          (plainText ? (
            <pre className={styles.plainTextPreview}>{content}</pre>
          ) : (
            <MarkdownRenderer content={content} />
          ))}
      </div>
    </Modal>
  );
};
