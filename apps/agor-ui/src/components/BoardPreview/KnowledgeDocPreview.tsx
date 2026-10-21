import type { AgorClient, HydratedKnowledgeDocument } from '@agor-live/client';
import { Skeleton, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';

/** A Knowledge document in the preview, read-only, under the reader's own access. */
export const KnowledgeDocPreview: React.FC<{ client: AgorClient | null; documentId: string }> = ({
  client,
  documentId,
}) => {
  const { token } = theme.useToken();
  const [state, setState] = useState<{
    id: string;
    doc?: HydratedKnowledgeDocument;
    failed?: boolean;
  } | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .service('kb/documents')
      .get(documentId, { query: { include_content: true } })
      .then((doc) => {
        if (!cancelled) setState({ id: documentId, doc: doc as HydratedKnowledgeDocument });
      })
      .catch(() => {
        if (!cancelled) setState({ id: documentId, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [client, documentId]);

  const current = state?.id === documentId ? state : null;
  const padding = { padding: `${token.paddingSM}px ${token.paddingMD}px` };
  if (!current) return <Skeleton active style={padding} />;
  if (current.failed || !current.doc) {
    return (
      <Typography.Text type="secondary" style={{ display: 'block', ...padding }}>
        No longer available
      </Typography.Text>
    );
  }
  return (
    <div style={padding}>
      <MarkdownRenderer content={current.doc.content ?? ''} />
    </div>
  );
};
