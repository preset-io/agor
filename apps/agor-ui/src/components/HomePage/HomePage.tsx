import { Space, Typography, theme } from 'antd';
import { memo } from 'react';
import { DEFAULT_BACKGROUNDS } from '../../constants/ui';
import { useAgorStore } from '../../store/agorStore';
import {
  selectBoardById,
  selectBranchById,
  selectRepoById,
  selectSessionById,
  selectSessionsByBranch,
  selectUserById,
} from '../../store/selectors';
import { isDarkTheme } from '../../utils/theme';
import { HomeActivitySection } from './HomeActivitySection';
import { HomeBoardsSection } from './HomeBoardsSection';
import { HomeKnowledgeSection } from './HomeKnowledgeSection';
import { HomeSessionsSection } from './HomeSessionsSection';
import type { HomePageProps } from './types';

const { Text, Title } = Typography;

export const HomePage = memo(function HomePage(props: HomePageProps) {
  const { token } = theme.useToken();
  const homeBackground = DEFAULT_BACKGROUNDS[isDarkTheme(token) ? 'dark' : 'light'];
  // Subscribe to entity maps by slice from the store: each selector only wakes
  // this large home surface when its own slice changes.
  const boardById = useAgorStore(selectBoardById);
  const branchById = useAgorStore(selectBranchById);
  const repoById = useAgorStore(selectRepoById);
  const sessionById = useAgorStore(selectSessionById);
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  const userById = useAgorStore(selectUserById);
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
            boardById={boardById}
            recentBoardIds={props.recentBoardIds}
            branchById={branchById}
            sessionsByBranch={sessionsByBranch}
            onBoardClick={props.onBoardClick}
          />
          <HomeSessionsSection
            sessionById={sessionById}
            branchById={branchById}
            boardById={boardById}
            repoById={repoById}
            currentUserId={props.currentUserId}
            onSessionClick={props.onSessionClick}
          />
        </main>
        <aside style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <HomeActivitySection
            branchById={branchById}
            boardById={boardById}
            sessionById={sessionById}
            userById={userById}
            onBoardClick={props.onBoardClick}
            onBranchClick={props.onBranchClick}
            onSessionClick={props.onSessionClick}
          />
          <HomeKnowledgeSection client={props.client} connected={props.connected} />
        </aside>
      </div>
    </div>
  );
});

export default HomePage;
