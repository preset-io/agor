// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Staged Marketplace panel for the demo-video "marketplace" scene.
//
// CatalogTab is the REAL product component — grid, detail drawer, branch
// picker, and the actual `handleConnect` request/response flow — backed by
// the stub AgorClient in demoMarketplaceClient.ts instead of a live daemon.
// CatalogTab calls `useNavigate()` internally (it navigates to the new
// session's URL after a successful Connect) — the app already renders this
// whole page inside a Router, so that resolves for free.
import { Layout, theme } from 'antd';
import { CatalogTab } from '../../components/Marketplace';
import { createDemoMarketplaceClient, DEMO_MARKETPLACE_USER } from './demoMarketplaceClient';

const DEMO_CLIENT = createDemoMarketplaceClient();

export const DemoMarketplaceStage = () => {
  const { token } = theme.useToken();

  return (
    <div
      data-testid="demo-marketplace-stage"
      style={{
        position: 'absolute',
        top: 64,
        left: '8%',
        right: '8%',
        bottom: '6%',
        zIndex: 30,
        borderRadius: token.borderRadiusLG,
        overflow: 'hidden',
        boxShadow: '0 24px 90px rgba(0, 0, 0, 0.5)',
        border: `1px solid ${token.colorBorder}`,
      }}
    >
      <Layout style={{ height: '100%', background: token.colorBgContainer }}>
        <div style={{ height: '100%', overflow: 'hidden', padding: token.paddingLG }}>
          <CatalogTab
            // biome-ignore lint/suspicious/noExplicitAny: demo-only stub client, not a real AgorClient
            client={DEMO_CLIENT as any}
            connected={true}
            connecting={false}
            authGeneration={1}
            currentUser={DEMO_MARKETPLACE_USER}
          />
        </div>
      </Layout>
    </div>
  );
};
