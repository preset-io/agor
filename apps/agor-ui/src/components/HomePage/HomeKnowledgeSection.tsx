import type { AgorClient } from '@agor-live/client';
import { BulbOutlined, FileOutlined } from '@ant-design/icons';
import { Card, Empty, List, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildKnowledgeRoutePath, namespaceSlugFromUri } from '../../utils/knowledgeRoutes';
import { formatRelativeTime } from '../../utils/time';
import { KnowledgeNamespacePill } from '../Pill';
import { HomeSectionHeader } from './HomeSectionHeader';
import { glassCardStyle } from './homeStyles';
import type { KnowledgeDocument } from './types';

const { Text } = Typography;

const HOME_KNOWLEDGE_LIMIT = 50;

const normalizeFindResult = <T,>(result: T[] | { data?: T[] }): T[] =>
  Array.isArray(result) ? result : (result.data ?? []);

const KnowledgeDocRow: React.FC<{ doc: KnowledgeDocument }> = ({ doc }) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const namespace = namespaceSlugFromUri(doc.uri);
  const path = buildKnowledgeRoutePath('/knowledge', namespace, doc.path);
  return (
    <List.Item onClick={() => navigate(path)} style={{ cursor: 'pointer', padding: '10px 0' }}>
      <List.Item.Meta
        avatar={
          doc.icon_emoji ? (
            <span style={{ fontSize: 18, lineHeight: '22px' }}>{doc.icon_emoji}</span>
          ) : (
            <FileOutlined style={{ color: token.colorTextTertiary }} />
          )
        }
        title={
          <Space size={6} style={{ maxWidth: '100%' }}>
            <Text ellipsis={{ tooltip: doc.title || doc.path }} style={{ minWidth: 0 }}>
              {doc.title || doc.path}
            </Text>
            <KnowledgeNamespacePill
              namespace={namespace || 'Knowledge'}
              style={{ marginInlineEnd: 0 }}
            />
          </Space>
        }
        description={
          <Space size={6} wrap>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {doc.path}
            </Text>
            {doc.updated_at && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                · {formatRelativeTime(doc.updated_at)}
              </Text>
            )}
          </Space>
        }
      />
    </List.Item>
  );
};

export const HomeKnowledgeSection: React.FC<{ client: AgorClient | null; connected?: boolean }> = ({
  client,
  connected,
}) => {
  const { token } = theme.useToken();
  const cardGlassStyle = glassCardStyle(token);
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!client) return;
    setLoading(true);
    client
      .service('kb/documents')
      .find({ query: { archived: false, $limit: HOME_KNOWLEDGE_LIMIT, $sort: { updated_at: -1 } } })
      .then((result) => {
        if (cancelled) return;
        const rows = normalizeFindResult<KnowledgeDocument>(result as KnowledgeDocument[])
          .sort(
            (a, b) =>
              new Date(b.updated_at || b.created_at || 0).getTime() -
              new Date(a.updated_at || a.created_at || 0).getTime()
          )
          .slice(0, HOME_KNOWLEDGE_LIMIT);
        setDocs(rows);
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to load recent Knowledge:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);
  return (
    <Card
      loading={loading}
      style={{ minHeight: 0, flex: 1, ...cardGlassStyle }}
      styles={{
        body: {
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'transparent',
        },
      }}
    >
      <HomeSectionHeader
        title="Recent Knowledge"
        icon={<BulbOutlined />}
        info={`Up to ${HOME_KNOWLEDGE_LIMIT} recently updated readable Knowledge documents from kb/documents. Access checks remain server-side through the existing Knowledge service.`}
      />
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        {!connected ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Reconnect to refresh Knowledge"
          />
        ) : docs.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No Knowledge docs yet" />
        ) : (
          <List
            rowKey="document_id"
            dataSource={docs}
            renderItem={(doc) => <KnowledgeDocRow doc={doc} />}
          />
        )}
      </div>
    </Card>
  );
};
