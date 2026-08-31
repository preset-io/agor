/**
 * Catalog surface: browse reviewed MCP servers and connect one.
 *
 * A standalone surface rather than a workspace route — it reads the checked-in
 * curated catalog and does not need the tenant's boards, sessions or canvas,
 * so it keeps the same lightweight chrome as Knowledge.
 *
 * Catalog browsing stays static while the personal tabs share one explicit,
 * caller-scoped overview projection and live invalidation loop.
 */

import type { User } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { ArrowLeftOutlined, ShopOutlined } from '@ant-design/icons';
import { Button, Grid, Layout, Space, Tabs, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';
import { GlobalUserMenu } from '../components/GlobalUserMenu';
import {
  CatalogTab,
  CredentialsTab,
  MyServersTab,
  SessionsTab,
  useMarketplaceOverview,
} from '../components/Marketplace';

const { Header, Content } = Layout;
const { Text, Title, Paragraph } = Typography;

const HEADER_HEIGHT = 56;

export interface MarketplacePageProps {
  client: AgorClient | null;
  /**
   * The daemon socket has connected and authenticated.
   *
   * The client object exists from the moment the socket is being built, so
   * this — not `client !== null` — is what says a read will be answered. The
   * workspace shell blocks its whole render until it is true; a lightweight
   * surface renders immediately and has to carry the distinction itself.
   */
  connected: boolean;
  /** True during disconnect grace and in-place token authentication. */
  connecting: boolean;
  /** Successful socket-auth generation from useAgorClient. */
  authGeneration: number;
  currentUser?: User | null;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
}

export const MarketplacePage: React.FC<MarketplacePageProps> = ({
  client,
  connected,
  connecting,
  authGeneration,
  currentUser,
  onUserSettingsClick,
  onLogout,
}) => {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const navigate = useNavigate();
  const location = useLocation();
  const requestedTab = location.pathname.split('/')[2];
  const activeTab = ['catalog', 'servers', 'sessions', 'credentials'].includes(requestedTab)
    ? requestedTab
    : 'catalog';
  useEffect(() => {
    if (requestedTab === undefined || requestedTab === activeTab) return;
    navigate(activeTab === 'catalog' ? '/catalog' : `/catalog/${activeTab}`, { replace: true });
  }, [activeTab, navigate, requestedTab]);

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
    <Layout style={{ height: '100vh', background: token.colorBgLayout }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: HEADER_HEIGHT,
          padding: `0 ${token.padding}px`,
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Space size={token.marginSM}>
          <Button
            type="text"
            aria-label="Back to workspace"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/')}
          />
          <BrandLogo level={3} style={{ marginTop: -4 }} />
          <Space data-testid="catalog-header-brand" align="center" size={token.marginXS}>
            <ShopOutlined style={{ color: token.colorTextSecondary }} />
            <Text strong>Catalog</Text>
          </Space>
        </Space>
        <GlobalUserMenu
          user={currentUser}
          onUserSettingsClick={onUserSettingsClick}
          onLogout={onLogout}
        />
      </Header>

      <Content
        style={{
          height: `calc(100vh - ${HEADER_HEIGHT}px)`,
          overflow: 'auto',
          padding: screens.md ? token.paddingLG : token.paddingSM,
        }}
      >
        <div style={{ maxWidth: 1400, margin: '0 auto' }}>
          <Title level={3} style={{ marginTop: 0, marginBottom: token.marginXXS }}>
            Catalog
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: token.margin }}>
            Attach tools to your agents — browse, review permissions, connect.
          </Paragraph>
          <Tabs
            activeKey={activeTab}
            onChange={(key) => navigate(key === 'catalog' ? '/catalog' : `/catalog/${key}`)}
            items={[
              {
                key: 'catalog',
                label: 'Catalog',
                children: (
                  <CatalogTab
                    active={activeTab === 'catalog'}
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
                    active={activeTab === 'servers'}
                    client={client}
                    connected={connected}
                    connecting={connecting}
                    authGeneration={authGeneration}
                    currentUser={currentUser}
                    {...overview}
                    onBrowseCatalog={() => navigate('/catalog')}
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
                    client={client}
                    authorityKey={authorityKey}
                    {...overview}
                    onBrowseCatalog={() => navigate('/catalog')}
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
                      navigate('/catalog/servers');
                    }}
                    onBrowseCatalog={() => navigate('/catalog')}
                  />
                ),
              },
            ]}
          />
        </div>
      </Content>
    </Layout>
  );
};
