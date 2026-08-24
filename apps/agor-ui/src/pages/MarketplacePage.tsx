/**
 * Marketplace surface: browse the MCP catalog and connect a server.
 *
 * A standalone surface rather than a workspace route — it reads the global
 * catalog table and does not need the tenant's boards, sessions or canvas, so
 * it keeps the same lightweight chrome as Knowledge.
 *
 * The Catalog is the only tab in this slice. My Servers, Sessions and
 * Credentials arrive with the data models behind them.
 */

import type { User } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { ArrowLeftOutlined, ShopOutlined } from '@ant-design/icons';
import { Button, Layout, Space, Typography, theme } from 'antd';
import { useNavigate } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';
import { GlobalUserMenu } from '../components/GlobalUserMenu';
import { CatalogTab } from '../components/Marketplace';

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
  currentUser?: User | null;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
}

export const MarketplacePage: React.FC<MarketplacePageProps> = ({
  client,
  connected,
  currentUser,
  onUserSettingsClick,
  onLogout,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();

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
          <Text
            strong
            style={{ display: 'inline-flex', alignItems: 'center', gap: token.sizeUnit }}
          >
            <ShopOutlined style={{ color: token.colorTextSecondary }} />
            Marketplace
          </Text>
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
          padding: token.paddingLG,
        }}
      >
        <div style={{ maxWidth: 1400, margin: '0 auto' }}>
          <Title level={3} style={{ marginTop: 0, marginBottom: token.marginXXS }}>
            Marketplace
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: token.margin }}>
            Attach tools to your agents — browse, review permissions, connect.
          </Paragraph>
          <CatalogTab client={client} connected={connected} currentUserId={currentUser?.user_id} />
        </div>
      </Content>
    </Layout>
  );
};
