// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing screenshot palette

import { App as AntdApp, ConfigProvider, Layout, theme } from 'antd';
import { useEffect, useMemo } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { AppHeader } from '../components/AppHeader';
import { SessionCanvas } from '../components/SessionCanvas';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import { agorStore } from '../store/agorStore';
import {
  demoActiveUsers as activeUsers,
  demoBoard as board,
  demoBoardId as boardId,
  demoBranches as branches,
  buildDemoStoreMaps,
  demoComments as comments,
  demoStaticCursors as staticCursors,
  demoUsers as users,
} from './marketing/fixtureData';
import './MarketingScreenshotPage.css';

export const MarketingScreenshotPage = () => {
  useEffect(() => {
    document.title = 'Launch board · Agor';
  }, []);

  const maps = useMemo(() => buildDemoStoreMaps(), []);

  // Seed the global store with the demo fixtures so SessionCanvas's selector
  // subscriptions resolve against them — the canvas reads entity state from the
  // store, not props. This standalone demo route owns the store for its lifetime.
  // Seeding runs in an effect (not during render) so the external singleton is
  // mutated as a commit side effect rather than mid-render.
  useEffect(() => {
    agorStore.setState({
      boardById: maps.boardById,
      repoById: maps.repoById,
      branchById: maps.branchById,
      sessionById: maps.sessionById,
      sessionsByBranch: maps.sessionsByBranch,
      boardObjectById: maps.boardObjectById,
      boardObjectsByBoardId: maps.boardObjectsByBoardId,
      cardById: maps.cardById,
      userById: maps.userById,
      commentById: maps.commentById,
      // AppHeader's GlobalSearch reads artifacts + MCP servers from the store;
      // pin them empty so a previously-populated workspace store can't leak its
      // entities into this standalone demo regardless of prior state.
      artifactById: new Map(),
      mcpServerById: new Map(),
    });
  }, [maps]);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#14b8a6',
          borderRadius: 12,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      }}
    >
      <AntdApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <Layout className="marketing-product-page" data-testid="marketing-screenshot-page">
            <AppHeader
              user={users[0]}
              presenceClient={null}
              currentUserId={users[0].user_id}
              staticActiveUsers={activeUsers}
              connected={true}
              connecting={false}
              currentBoardName={board.name}
              currentBoardIcon={board.icon}
              unreadCommentsCount={comments.length}
              eventStreamEnabled={true}
              hasUserMentions={true}
              currentBoardId={boardId}
            />
            <main className="marketing-product-canvas">
              <ReactFlowProvider>
                <SessionCanvas
                  board={board}
                  client={null}
                  branches={branches}
                  currentUserId={users[0].user_id}
                  selectedSessionId={null}
                  availableAgents={[]}
                  staticCursors={staticCursors}
                  staticCursorScale={1.3}
                  height="calc(100vh - 64px)"
                />
              </ReactFlowProvider>
            </main>
          </Layout>
        </ConnectionProvider>
      </AntdApp>
    </ConfigProvider>
  );
};

export default MarketingScreenshotPage;
