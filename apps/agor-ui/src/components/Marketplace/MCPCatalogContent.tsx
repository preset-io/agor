import type { SessionID, User } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Grid, Tabs, Typography } from 'antd';
import { useId, useRef, useState } from 'react';
import { CatalogTab } from './CatalogTab';
import { CredentialsTab } from './CredentialsTab';
import { MyServersTab } from './MyServersTab';
import { useAddCustomMcpServer } from './useAddCustomMcpServer';
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
 * The MCP Catalog / Marketplace inner content (Catalog, My Servers, Credentials
 * tabs). Shared by the desktop MCPCatalogModal chrome and the mobile
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
  const canManageCredentials = Boolean(
    client &&
      connected &&
      !connecting &&
      currentUser?.user_id &&
      hasMinimumRole(currentUser.role, ROLES.MEMBER)
  );
  const openServerSettings = (serverId: string) => {
    setRequestedServerId(serverId);
    setActiveTab('servers');
  };
  // Held until the form closes: My Servers must not open its drawer over a form mid-OAuth.
  const addedServerId = useRef<string | null>(null);
  const addCustom = useAddCustomMcpServer({
    client,
    connected,
    connecting,
    authGeneration,
    currentUser,
    onCreated: (server) => {
      addedServerId.current = server.mcp_server_id;
    },
    onClose: () => {
      void overview.refresh();
      const serverId = addedServerId.current;
      addedServerId.current = null;
      if (serverId) openServerSettings(serverId);
    },
  });
  const screens = Grid.useBreakpoint();
  const narrow = screens.xs === true && screens.sm !== true;

  return (
    <>
      <Typography.Paragraph type="secondary">
        Attach tools to your agents — browse, review permissions, connect.
      </Typography.Paragraph>
      {addCustom.modal}
      <Tabs
        id={tabsId}
        activeKey={activeTab}
        onChange={setActiveTab}
        // One spot for the primary action, apart from the Catalog's filters.
        tabBarExtraContent={
          activeTab === 'credentials' ? undefined : narrow ? addCustom.iconButton : addCustom.button
        }
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
                addCustomServerAction={addCustom.button}
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
                onOpenSession={onOpenSession}
                requestedServerId={requestedServerId}
                onRequestedServerOpened={() => setRequestedServerId(null)}
              />
            ),
          },
          {
            key: 'credentials',
            label: `Credentials${overview.overview.credentials.length ? ` (${overview.overview.credentials.length})` : ''}`,
            children: (
              <CredentialsTab
                {...overview}
                canManageCredentials={canManageCredentials}
                onOpenServerSettings={openServerSettings}
                onBrowseCatalog={() => setActiveTab('catalog')}
              />
            ),
          },
        ]}
      />
    </>
  );
}
