import type { SessionID, User } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { ShopOutlined } from '@ant-design/icons';
import { Modal, Space, Tabs, Typography, theme } from 'antd';
import { useId, useState } from 'react';
import {
  CatalogTab,
  CredentialsTab,
  MyServersTab,
  SessionsTab,
  useMarketplaceOverview,
} from './index';

export interface MCPCatalogModalProps {
  client: AgorClient | null;
  connected: boolean;
  connecting: boolean;
  authGeneration: number;
  currentUser?: User | null;
  open: boolean;
  onClose: () => void;
  afterClose: () => void;
  onOpenSession: (sessionId: SessionID) => void;
}

/** One ephemeral shell around the existing Catalog and caller-scoped personal tabs. */
export function MCPCatalogModal({
  client,
  connected,
  connecting,
  authGeneration,
  currentUser,
  open,
  onClose,
  afterClose,
  onOpenSession,
}: MCPCatalogModalProps) {
  const { token } = theme.useToken();
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
    <Modal
      title={
        <Space>
          <ShopOutlined aria-hidden />
          <span>MCP Catalog</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      afterClose={afterClose}
      focusable={{ focusTriggerAfterClose: false }}
      footer={null}
      width={1200}
      style={{
        top: token.margin,
        maxWidth: `calc(100vw - ${token.marginSM * 2}px)`,
        paddingBottom: 0,
      }}
      styles={{
        body: {
          height: `min(760px, calc(100dvh - ${token.margin * 2 + 100}px))`,
          overflow: 'auto',
        },
      }}
    >
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
                active={open && activeTab === 'catalog'}
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
                active={open && activeTab === 'servers'}
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
    </Modal>
  );
}
