import {
  ArrowLeftOutlined,
  BellOutlined,
  CheckOutlined,
  DownOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Badge, Button, Drawer, Flex, Layout, List, Space, Typography, theme } from 'antd';
import { useState } from 'react';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { pressableProps } from '../../utils/pressableProps';
import { BrandMark } from '../BrandMark';

const { Header } = Layout;
const { Title } = Typography;

export interface BoardSwitcherOption {
  board_id: string;
  name: string;
  emoji?: string;
}

interface MobileHeaderProps {
  title?: string;
  showLogo?: boolean;
  /** When set, a back arrow appears on the left. */
  onBack?: () => void;
  /** When set, a search icon appears on the right (opens the search screen). */
  onSearch?: () => void;
  /** When set, a bell icon appears on the right that opens comments/mentions. */
  onOpenComments?: () => void;
  /** Unread comments/mentions count shown on the bell (0 hides the badge). */
  commentsBadge?: number;
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

// The signed-in identity/account lives in the More sheet, so the header stays a
// title (+ optional back and board switcher) without a duplicated avatar.
export const MobileHeader: React.FC<MobileHeaderProps> = ({
  title,
  showLogo = false,
  onBack,
  onSearch,
  onOpenComments,
  commentsBadge,
  boardSwitcher,
}) => {
  const { token } = theme.useToken();
  const reduced = usePrefersReducedMotion();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const iconButtonStyle = { minWidth: MOBILE_TOUCH_TARGET, minHeight: MOBILE_TOUCH_TARGET };

  return (
    <Header
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: token.marginSM,
        paddingInline: token.padding,
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
            style={{ ...iconButtonStyle, marginInlineStart: -token.marginXS }}
          />
        )}
        {showLogo && <BrandMark size={32} />}
        {boardSwitcher ? (
          <Button
            type="text"
            onClick={() => setSwitcherOpen(true)}
            aria-label={`Switch board (current: ${title ?? 'board'})`}
            style={{
              paddingInline: 0,
              minWidth: 0,
              maxWidth: '100%',
              minHeight: MOBILE_TOUCH_TARGET,
            }}
          >
            <Space size={token.marginXXS} align="center" style={{ maxWidth: '100%' }}>
              <Title
                level={5}
                ellipsis
                style={{ margin: 0, fontSize: token.fontSizeLG, fontWeight: 500 }}
              >
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
              fontSize: showLogo ? token.fontSizeXL : token.fontSizeLG,
              fontWeight: showLogo ? 400 : 500,
            }}
          >
            {title || 'agor'}
          </Title>
        )}
      </Space>

      {onSearch && (
        <Button
          type="text"
          aria-label="Search"
          icon={<SearchOutlined />}
          onClick={onSearch}
          style={iconButtonStyle}
        />
      )}

      {onOpenComments && (
        <Badge count={commentsBadge ?? 0} size="small" offset={[-6, 6]}>
          <Button
            type="text"
            aria-label="Comments"
            icon={<BellOutlined />}
            onClick={onOpenComments}
            style={iconButtonStyle}
          />
        </Badge>
      )}

      {boardSwitcher && (
        <Drawer
          open={switcherOpen}
          onClose={() => setSwitcherOpen(false)}
          placement="bottom"
          height="auto"
          title="Switch board"
          {...reducedMotionSurface(reduced)}
          styles={{ body: { padding: 0, paddingBottom: 'env(safe-area-inset-bottom)' } }}
        >
          <List
            dataSource={boardSwitcher.boards}
            renderItem={(board) => {
              const active = board.board_id === boardSwitcher.currentBoardId;
              const select = () => {
                setSwitcherOpen(false);
                boardSwitcher.onSelect(board.board_id);
              };
              return (
                <List.Item
                  {...pressableProps(select)}
                  aria-label={`Switch to ${board.name}`}
                  style={{
                    cursor: 'pointer',
                    paddingInline: token.padding,
                    minHeight: MOBILE_TOUCH_TARGET,
                  }}
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
