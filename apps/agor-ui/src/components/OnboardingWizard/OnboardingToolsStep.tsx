import { catalogServerSlug, type MCPCatalogEntry } from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { CheckCircleFilled, SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Input, Select, Skeleton, Tooltip, Typography, theme } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { CatalogTab } from '../Marketplace/CatalogTab';
import {
  ALL_CATEGORIES,
  CATEGORY_OPTIONS,
  type CategoryFilter,
  DEFAULT_SORT,
  entryTitle,
} from '../Marketplace/catalogPresentation';
import { useCatalogReadiness } from '../Marketplace/useCatalogReadiness';
import { type CatalogFilterState, useCatalogSearch } from '../Marketplace/useCatalogSearch';
import { McpLogo } from '../McpLogo';

interface Props {
  client: AgorClient | null;
  user?: User | null;
  connected: boolean;
  authGeneration: number;
  onConnected: (serverId: string) => void;
}

interface TileProps {
  entry: MCPCatalogEntry;
  client: AgorClient | null;
  connected: boolean;
  authGeneration: number;
  userId?: string;
  readinessRevision: number;
  onOpen: (event: React.MouseEvent<HTMLElement>) => void;
}

function ToolTile({
  entry,
  client,
  connected,
  authGeneration,
  userId,
  readinessRevision,
  onOpen,
}: TileProps) {
  const { token } = theme.useToken();
  const statusId = useId();
  const title = entryTitle(entry);
  const { readiness, refresh } = useCatalogReadiness({
    client,
    entryKey: entry.name,
    ready: connected,
    authGeneration,
    userId,
  });
  useEffect(() => {
    if (readinessRevision > 0) void refresh();
  }, [readinessRevision, refresh]);
  const isConnected = readiness?.state === 'installed_ready';

  return (
    <Tooltip
      title={
        <>
          <strong>{title}</strong>
          <br />
          {entry.benefit}
        </>
      }
      trigger={['hover', 'focus']}
    >
      <Button
        block
        aria-label={`${title}: view details`}
        aria-describedby={isConnected ? statusId : undefined}
        aria-haspopup="dialog"
        onClick={onOpen}
        style={{
          height: '100%',
          minHeight: token.controlHeightLG,
          padding: token.paddingXS,
          justifyContent: 'flex-start',
          textAlign: 'left',
          whiteSpace: 'normal',
        }}
      >
        <Flex align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
          <McpLogo id={catalogServerSlug(entry.name)} size={token.sizeMD} color={token.colorText} />
          <Flex vertical style={{ minWidth: 0 }}>
            <Typography.Paragraph
              ellipsis={{ rows: 2 }}
              style={{ margin: 0, fontSize: token.fontSize, overflowWrap: 'break-word' }}
            >
              {title}
            </Typography.Paragraph>
            {isConnected && (
              <Typography.Text id={statusId} type="success" style={{ fontSize: token.fontSizeSM }}>
                <CheckCircleFilled /> Connected
              </Typography.Text>
            )}
          </Flex>
        </Flex>
      </Button>
    </Tooltip>
  );
}

function ToolsForIdentity({ client, user, connected, authGeneration, onConnected }: Props) {
  const { token } = theme.useToken();
  const narrow = useMediaQuery('(max-width: 480px)');
  const [filters, setFilters] = useState<CatalogFilterState>({ search: '', sort: DEFAULT_SORT });
  const { matches, status, error, retry } = useCatalogSearch(client, connected, filters, 1);
  const [readinessRevision, setReadinessRevision] = useState(0);
  const [entry, setEntry] = useState<string>();
  const trigger = useRef<HTMLElement | null>(null);
  const close = () => {
    setEntry(undefined);
    const source = trigger.current;
    requestAnimationFrame(() => {
      if (source?.isConnected) source.focus();
    });
  };

  return (
    <Flex vertical gap={token.marginSM} style={{ flex: '1 1 auto', minHeight: 0 }}>
      <Typography.Paragraph style={{ color: token.colorTextSecondary, margin: 0 }}>
        Your teammate can work with all of these tools. Connect one now, or skip and do it later.
      </Typography.Paragraph>
      <Flex gap={token.marginXS}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search tools"
          aria-label="Search tools"
          value={filters.search}
          onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Select<CategoryFilter>
          prefix="Category"
          aria-label="Filter by category"
          value={filters.category ?? ALL_CATEGORIES}
          onChange={(value) =>
            setFilters((prev) => ({
              ...prev,
              category: value === ALL_CATEGORIES ? undefined : value,
            }))
          }
          options={CATEGORY_OPTIONS}
          popupMatchSelectWidth={false}
          styles={{ prefix: { color: token.colorTextSecondary } }}
          style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '45%' }}
        />
      </Flex>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        {status === 'error' ? (
          <Alert
            type="error"
            showIcon
            title="Could not load the catalog"
            description={error}
            action={
              <Button size="small" onClick={retry}>
                Retry
              </Button>
            }
          />
        ) : status === 'loading' ? (
          <Skeleton active />
        ) : matches.length === 0 ? (
          <Typography.Text type="secondary">No tools match "{filters.search}".</Typography.Text>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${narrow ? 2 : 3}, minmax(0, 1fr))`,
              gap: token.marginXS,
            }}
          >
            {matches.map((item) => (
              <ToolTile
                key={item.name}
                entry={item}
                client={client}
                connected={connected}
                authGeneration={authGeneration}
                userId={user?.user_id}
                readinessRevision={readinessRevision}
                onOpen={(event) => {
                  trigger.current = event.currentTarget;
                  setEntry(item.name);
                }}
              />
            ))}
          </div>
        )}
        <Typography.Paragraph
          type="secondary"
          style={{ fontSize: token.fontSizeSM, margin: `${token.marginSM}px 0 0` }}
        >
          You can connect more tools anytime from the Catalog, or ask your teammate to help.
        </Typography.Paragraph>
      </div>
      {entry && (
        <CatalogTab
          client={client}
          currentUser={user}
          connected={connected}
          connecting={!connected}
          authGeneration={authGeneration}
          context={{
            mode: 'onboarding',
            entryName: entry,
            onClose: close,
            onConnected: (serverId) => {
              onConnected(serverId);
              setReadinessRevision((value) => value + 1);
            },
          }}
        />
      )}
    </Flex>
  );
}

/** Replacement identity/auth generation destroys drawers and any retained private input. */
export function OnboardingToolsStep(props: Props) {
  return (
    <ToolsForIdentity
      key={`${props.user?.user_id}:${props.user?.role}:${props.authGeneration}:${props.connected}`}
      {...props}
    />
  );
}
