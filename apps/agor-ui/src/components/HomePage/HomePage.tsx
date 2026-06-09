import { Space, Typography, theme } from 'antd';
import type React from 'react';
import { DEFAULT_BACKGROUNDS } from '../../constants/ui';
import { isDarkTheme } from '../../utils/theme';
import { HomeActivitySection } from './HomeActivitySection';
import { HomeBoardsSection } from './HomeBoardsSection';
import { HomeKnowledgeSection } from './HomeKnowledgeSection';
import { HomeSessionsSection } from './HomeSessionsSection';
import type { HomePageProps } from './types';

const { Text, Title } = Typography;

export const HomePage: React.FC<HomePageProps> = (props) => {
  const { token } = theme.useToken();
  const homeBackground = DEFAULT_BACKGROUNDS[isDarkTheme(token) ? 'dark' : 'light'];
  return (
    <div style={{ height: '100%', width: '100%', overflow: 'hidden', background: homeBackground }}>
      <div
        style={{
          height: '100%',
          minHeight: 0,
          padding: '32px clamp(32px, 5vw, 80px) 28px',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(380px, 540px)',
          gap: 24,
        }}
      >
        <main
          style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 24 }}
        >
          <div>
            <Space direction="vertical" size={4}>
              <Title level={2} style={{ margin: 0 }}>
                Home
              </Title>
              <Text type="secondary">
                Jump into boards, resume your sessions, and see recent team context.
              </Text>
            </Space>
          </div>
          <HomeBoardsSection
            boardById={props.boardById}
            recentBoardIds={props.recentBoardIds}
            branchById={props.branchById}
            sessionsByBranch={props.sessionsByBranch}
            onBoardClick={props.onBoardClick}
          />
          <HomeSessionsSection
            sessionById={props.sessionById}
            branchById={props.branchById}
            boardById={props.boardById}
            repoById={props.repoById}
            onSessionClick={props.onSessionClick}
          />
        </main>
        <aside style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <HomeActivitySection
            branchById={props.branchById}
            boardById={props.boardById}
            userById={props.userById}
            onBoardClick={props.onBoardClick}
            onBranchClick={props.onBranchClick}
          />
          <HomeKnowledgeSection client={props.client} connected={props.connected} />
        </aside>
      </div>
    </div>
  );
};

export default HomePage;
