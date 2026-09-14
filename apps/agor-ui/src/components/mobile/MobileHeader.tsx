import type { User } from '@agor-live/client';
import { ArrowLeftOutlined, CheckOutlined, DownOutlined } from '@ant-design/icons';
import { Button, Drawer, Flex, Layout, List, Space, Typography, theme } from 'antd';
import { useState } from 'react';
import { BrandMark } from '../BrandMark';
import { UserIdentityAvatar } from '../UserIdentityAvatar';

const { Header } = Layout;
const { Title } = Typography;

export interface BoardSwitcherOption {
  board_id: string;
  name: string;
  emoji?: string;
}

interface MobileHeaderProps {
  title?: string;
  user?: User | null;
  showLogo?: boolean;
  /** When set, a back arrow appears on the left. */
  onBack?: () => void;
  /**
   * When set, the title becomes a button with a chevron that opens a compact
   * board-switch sheet.
   */
  boardSwitcher?: {
    boards: BoardSwitcherOption[];
    currentBoardId?: string;
    onSelect: (boardId: string) => void;
  };
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({
  title,
  user,
  showLogo = false,
  onBack,
  boardSwitcher,
}) => {
  const { token } = theme.useToken();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  return (
    <Header
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: token.marginSM,
        paddingInline: 16,
        background: token.colorBgContainer,
        borderBottom: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Space size={token.marginXS} align="center" style={{ flex: 1, minWidth: 0 }}>
        {onBack && (
          <Button
            type="text"
            aria-label="Back"
            icon={<ArrowLeftOutlined />}
            onClick={onBack}
            style={{ marginInlineStart: -token.marginXS }}
          />
        )}
        {showLogo && <BrandMark size={32} />}
        {boardSwitcher ? (
          <Button
            type="text"
            onClick={() => setSwitcherOpen(true)}
            aria-label={`Switch board — current: ${title ?? 'board'}`}
            style={{ paddingInline: 0, minWidth: 0, maxWidth: '100%' }}
          >
            <Space size={token.marginXXS} align="center" style={{ maxWidth: '100%' }}>
              <Title level={5} ellipsis style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>
                {title || 'agor'}
              </Title>
              <DownOutlined
                style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}
              />
            </Space>
          </Button>
        ) : (
          <Title
            level={5}
            ellipsis
            style={{
              margin: 0,
              color: token.colorText,
              fontSize: showLogo ? 18 : 16,
              fontWeight: showLogo ? 400 : 500,
            }}
          >
            {title || 'agor'}
          </Title>
        )}
      </Space>

      {user && <UserIdentityAvatar user={user} size={28} fontSize="20px" />}

      {boardSwitcher && (
        <Drawer
          open={switcherOpen}
          onClose={() => setSwitcherOpen(false)}
          placement="bottom"
          height="auto"
          title="Switch board"
          styles={{ body: { padding: 0, paddingBottom: 'env(safe-area-inset-bottom)' } }}
        >
          <List
            dataSource={boardSwitcher.boards}
            renderItem={(board) => {
              const active = board.board_id === boardSwitcher.currentBoardId;
              return (
                <List.Item
                  onClick={() => {
                    setSwitcherOpen(false);
                    boardSwitcher.onSelect(board.board_id);
                  }}
                  style={{ cursor: 'pointer', paddingInline: 16, minHeight: 44 }}
                >
                  <Flex align="center" gap={token.marginSM} style={{ width: '100%', minWidth: 0 }}>
                    {board.emoji && <span aria-hidden>{board.emoji}</span>}
                    <Typography.Text ellipsis style={{ flex: 1, fontWeight: active ? 600 : 400 }}>
                      {board.name}
                    </Typography.Text>
                    {active && <CheckOutlined style={{ color: token.colorPrimary }} />}
                  </Flex>
                </List.Item>
              );
            }}
          />
        </Drawer>
      )}
    </Header>
  );
};
