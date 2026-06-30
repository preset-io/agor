import type { AgorClient } from '@agor-live/client';
import { BulbOutlined, FileOutlined, SearchOutlined } from '@ant-design/icons';
import { Card, Empty, Input, List, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildKnowledgeRoutePath, namespaceSlugFromUri } from '../../utils/knowledgeRoutes';
import { formatRelativeTime } from '../../utils/time';
import { KnowledgeNamespacePill } from '../Pill';
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
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const filteredDocs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) => (d.title || d.path).toLowerCase().includes(q) || d.path.toLowerCase().includes(q)
    );
  }, [docs, query]);
  useEffect(() => {
    let cancelled = false;
    if (!client || !connected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    client
      .service('kb/documents')
      .find({ query: { archived: false, $limit: HOME_KNOWLEDGE_LIMIT, $sort: { updated_at: -1 } } })
      .then((result) => {
        if (cancelled) return;
        setDocs(
          normalizeFindResult(result as KnowledgeDocument[] | { data?: KnowledgeDocument[] })
        );
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load knowledge docs');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, connected]);
  return (
    <section
      aria-label="Knowledge base"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 6 }}>
        <BulbOutlined style={{ color: token.colorTextSecondary, fontSize: 13 }} />
        <Text strong style={{ fontSize: 14, flex: 1 }}>
          Knowledge
        </Text>
        <Input
          size="small"
          placeholder="Search..."
          prefix={<SearchOutlined style={{ color: token.colorTextQuaternary, fontSize: 11 }} />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          allowClear
          style={{ flex: '0 1 120px', minWidth: 80, fontSize: 12 }}
        />
      </div>
      <Card
        loading={loading}
        style={{
          flex: 1,
          minHeight: 0,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          ...cardGlassStyle,
        }}
        styles={{
          body: {
            padding: 0,
            height: '100%',
            overflow: 'auto',
            background: 'transparent',
          },
        }}
      >
        {error ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={error}
            style={{ padding: '24px 0' }}
          />
        ) : docs.length === 0 && !connected ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Reconnect to refresh Knowledge"
            style={{ padding: '24px 0' }}
          />
        ) : docs.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No Knowledge docs yet"
            style={{ padding: '24px 0' }}
          />
        ) : filteredDocs.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No matching docs"
            style={{ padding: '24px 0' }}
          />
        ) : (
          <List
            rowKey="document_id"
            dataSource={filteredDocs}
            renderItem={(doc) => <KnowledgeDocRow doc={doc} />}
          />
        )}
      </Card>
    </section>
  );
};
