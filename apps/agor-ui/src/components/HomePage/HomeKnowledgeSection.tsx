import type { AgorClient } from '@agor-live/client';
import { FileOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input, Tooltip, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildKnowledgeRoutePath, namespaceSlugFromUri } from '../../utils/knowledgeRoutes';
import { formatRelativeTime } from '../../utils/time';
import { HomeBlock, HomeEmpty, HomeLink } from './HomeBlock';
import { compactRelativeTime, HomeRow, HomeTime } from './HomeRow';
import type { KnowledgeDocument } from './types';

const HOME_KNOWLEDGE_LIMIT = 50;
/** Home lists the latest few docs; filtering searches every loaded doc. */
const HOME_KNOWLEDGE_PREVIEW = 6;

const normalizeFindResult = <T,>(result: T[] | { data?: T[] }): T[] =>
  Array.isArray(result) ? result : (result.data ?? []);

const KnowledgeDocRow: React.FC<{ doc: KnowledgeDocument }> = ({ doc }) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const namespace = namespaceSlugFromUri(doc.uri);
  const path = buildKnowledgeRoutePath('/knowledge', namespace, doc.path);
  const title = doc.title || doc.path;
  const updated = doc.updated_at ? formatRelativeTime(doc.updated_at) : null;
  return (
    <HomeRow
      ariaLabel={`Open ${title}`}
      onOpen={() => navigate(path)}
      leading={
        <span
          style={{
            width: 16,
            display: 'inline-flex',
            justifyContent: 'center',
            fontSize: doc.icon_emoji ? 13 : token.fontSizeSM,
            color: token.colorTextTertiary,
          }}
        >
          {doc.icon_emoji || <FileOutlined />}
        </span>
      }
      title={title}
      tooltip={[title, `${namespace || 'Knowledge'} · ${doc.path}`, updated]
        .filter(Boolean)
        .join('\n')}
      trailing={updated ? <HomeTime>{compactRelativeTime(updated)}</HomeTime> : undefined}
    />
  );
};

export const HomeKnowledgeSection: React.FC<{ client: AgorClient | null; connected?: boolean }> = ({
  client,
  connected,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  // Escape closes the field; focus returns to the button that replaces it.
  const [refocusSearch, setRefocusSearch] = useState(false);
  useEffect(() => {
    if (!refocusSearch) return;
    searchButtonRef.current?.focus();
    setRefocusSearch(false);
  }, [refocusSearch]);

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
  const trimmedQuery = query.trim();
  const visibleDocs = trimmedQuery ? filteredDocs : filteredDocs.slice(0, HOME_KNOWLEDGE_PREVIEW);
  const emptyMessage = error
    ? error
    : loading && docs.length === 0
      ? 'Loading…'
      : docs.length === 0 && !connected
        ? 'Reconnect to refresh Knowledge'
        : docs.length === 0
          ? 'No Knowledge docs yet'
          : filteredDocs.length === 0
            ? 'No matching docs'
            : null;

  return (
    <HomeBlock
      label="Knowledge"
      surface
      actions={
        <>
          {searchOpen || query ? (
            <Input
              autoFocus
              size="small"
              variant="filled"
              placeholder="Search..."
              aria-label="Search Knowledge docs"
              prefix={<SearchOutlined style={{ color: token.colorTextQuaternary, fontSize: 11 }} />}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => setSearchOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('');
                  setSearchOpen(false);
                  setRefocusSearch(true);
                }
              }}
              allowClear
              style={{ width: 160, fontSize: 12 }}
            />
          ) : (
            <Tooltip title="Search Knowledge docs">
              <Button
                ref={searchButtonRef}
                type="text"
                size="small"
                aria-label="Search Knowledge docs"
                icon={<SearchOutlined />}
                onClick={() => setSearchOpen(true)}
                style={{ color: token.colorTextTertiary }}
              />
            </Tooltip>
          )}
          <HomeLink onClick={() => navigate('/knowledge')}>View all</HomeLink>
        </>
      }
    >
      <div style={trimmedQuery ? { maxHeight: 420, overflowY: 'auto' } : undefined}>
        {emptyMessage ? (
          <HomeEmpty>{emptyMessage}</HomeEmpty>
        ) : (
          visibleDocs.map((doc) => <KnowledgeDocRow key={doc.document_id} doc={doc} />)
        )}
      </div>
    </HomeBlock>
  );
};
