import type { SessionID, User } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Tabs, Typography } from 'antd';
import { useId, useState } from 'react';
import { CatalogTab } from './CatalogTab';
import { CredentialsTab } from './CredentialsTab';
import { MyServersTab } from './MyServersTab';
import { SessionsTab } from './SessionsTab';
import { useMarketplaceOverview } from './useMarketplaceOverview';

export interface MCPCatalogContentProps {
  client: AgorClient | null;
  connected: boolean;
  connecting: boolean;
  authGeneration: number;
  currentUser?: User | null;
  /** Whether this surface is on screen; gates per-tab data loading. */
  active: boolean;
  onOpenSession: (sessionId: SessionID) => void;
}

/**
 * The MCP Catalog / Marketplace inner content (Catalog, My Servers, Sessions,
 * Credentials tabs). Shared by the desktop MCPCatalogModal chrome and the mobile
 * full-screen Marketplace route, so both browse/connect the same way.
 */
export function MCPCatalogContent({
  client,
  connected,
  connecting,
  authGeneration,
  currentUser,
  active,
  onOpenSession,
}: MCPCatalogContentProps) {
  const tabsId = useId();
  const [activeTab, setActiveTab] = useState('catalog');
  const overview = useMarketplaceOverview({
    client,
    connected,
    connecting,
    authGeneration,
    userId: currentUser?.user_id,
    role: currentUser?.role,
  });
  const [requestedServerId, setRequestedServerId] = useState<string | null>(null);
  const authorityKey =
    client &&
    connected &&
    !connecting &&
    currentUser?.user_id &&
    hasMinimumRole(currentUser.role, ROLES.MEMBER)
      ? ([currentUser.user_id, currentUser.role, authGeneration, client] as const)
      : null;

  return (
    <>
      <Typography.Paragraph type="secondary">
        Attach tools to your agents — browse, review permissions, connect.
      </Typography.Paragraph>
      <Tabs
        id={tabsId}
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'catalog',
            label: 'Catalog',
            children: (
              <CatalogTab
                onOpenSession={onOpenSession}
                active={active && activeTab === 'catalog'}
                client={client}
                connected={connected}
                connecting={connecting}
                authGeneration={authGeneration}
                currentUser={currentUser}
                refreshMarketplaceOverview={overview.refresh}
              />
            ),
          },
          {
            key: 'servers',
            label: `My Servers${overview.overview.servers.length ? ` (${overview.overview.servers.length})` : ''}`,
            children: (
              <MyServersTab
                active={active && activeTab === 'servers'}
                client={client}
                connected={connected}
                connecting={connecting}
                authGeneration={authGeneration}
                currentUser={currentUser}
                {...overview}
                onBrowseCatalog={() => setActiveTab('catalog')}
                requestedServerId={requestedServerId}
                onRequestedServerOpened={() => setRequestedServerId(null)}
              />
            ),
          },
          {
            key: 'sessions',
            label: `Sessions${overview.overview.attachments.length ? ` (${new Set(overview.overview.attachments.map((item) => item.session_id)).size})` : ''}`,
            children: (
              <SessionsTab
                onOpenSession={onOpenSession}
                client={client}
                authorityKey={authorityKey}
                {...overview}
                onBrowseCatalog={() => setActiveTab('catalog')}
              />
            ),
          },
          {
            key: 'credentials',
            label: `Credentials${overview.overview.credentials.length ? ` (${overview.overview.credentials.length})` : ''}`,
            children: (
              <CredentialsTab
                {...overview}
                canManageCredentials={authorityKey !== null}
                onOpenServerSettings={(serverId) => {
                  setRequestedServerId(serverId);
                  setActiveTab('servers');
                }}
                onBrowseCatalog={() => setActiveTab('catalog')}
              />
            ),
          },
        ]}
      />
    </>
  );
}
