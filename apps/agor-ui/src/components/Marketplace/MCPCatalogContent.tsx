import type { SessionID, User } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Grid, Tabs, Typography, theme } from 'antd';
import { useId, useState } from 'react';
import { DrillCrumbs } from '../SettingsModal/SettingsDrill';
import { CatalogTab } from './CatalogTab';
import { CredentialsTab } from './CredentialsTab';
import { MyServersTab } from './MyServersTab';
import { useCustomMcpServerEditor } from './useCustomMcpServerEditor';
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
  const { token } = theme.useToken();
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
  // Adding or editing a custom server replaces the tabs in place (no modal on
  // the Catalog modal). Closing it lands on the server's My Servers settings;
  // a create reports its server only then, never over a form mid-OAuth.
  const editor = useCustomMcpServerEditor({
    client,
    connected,
    connecting,
    authGeneration,
    currentUser,
    onClose: (serverId) => {
      void overview.refresh();
      if (serverId) openServerSettings(serverId);
    },
  });
  const tabsActive = active && !editor.view;
  const screens = Grid.useBreakpoint();
  const narrow = screens.xs === true && screens.sm !== true;

  return (
    <>
      <Typography.Paragraph type="secondary">
        Attach tools to your agents — browse, review permissions, connect.
      </Typography.Paragraph>
      {editor.view && (
        <>
          <DrillCrumbs
            parent="MCP Catalog"
            onParent={editor.back}
            trail={editor.view.trail}
            current={editor.view.current}
          />
          <section aria-label={editor.view.current} style={{ marginTop: token.marginLG }}>
            {editor.view.editor}
          </section>
        </>
      )}
      {/* Hidden, not unmounted, so Back finds each tab as it was left. */}
      <div hidden={Boolean(editor.view)}>
        <Tabs
          id={tabsId}
          activeKey={activeTab}
          onChange={setActiveTab}
          // One spot for the action, apart from the Catalog's filters.
          tabBarExtraContent={
            activeTab === 'credentials' ? undefined : narrow ? editor.iconButton : editor.button
          }
          items={[
            {
              key: 'catalog',
              label: 'Catalog',
              children: (
                <CatalogTab
                  onOpenSession={onOpenSession}
                  active={tabsActive && activeTab === 'catalog'}
                  client={client}
                  connected={connected}
                  connecting={connecting}
                  authGeneration={authGeneration}
                  currentUser={currentUser}
                  refreshMarketplaceOverview={overview.refresh}
                  addCustomServerAction={editor.button}
                />
              ),
            },
            {
              key: 'servers',
              label: `My Servers${overview.overview.servers.length ? ` (${overview.overview.servers.length})` : ''}`,
              children: (
                <MyServersTab
                  active={tabsActive && activeTab === 'servers'}
                  client={client}
                  connected={connected}
                  connecting={connecting}
                  authGeneration={authGeneration}
                  currentUser={currentUser}
                  {...overview}
                  onBrowseCatalog={() => setActiveTab('catalog')}
                  onOpenSession={onOpenSession}
                  onEditServer={editor.openEdit}
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
      </div>
    </>
  );
}
