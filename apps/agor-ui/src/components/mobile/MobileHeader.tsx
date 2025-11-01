import type { User } from '@agor/core/types';
import { MenuOutlined } from '@ant-design/icons';
import { Button, Layout, Space, Typography } from 'antd';

const { Header } = Layout;
const { Title } = Typography;

interface MobileHeaderProps {
  showMenu?: boolean;
  showLogo?: boolean;
  title?: string;
  user?: User | null;
  onMenuClick?: () => void;
  onLogout?: () => void;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({
  showMenu = true,
  showLogo = false,
  title,
  user,
  onMenuClick,
  onLogout,
}) => {
  return (
    <Header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        background: '#001529', // Match desktop header
      }}
    >
      <Space size={8} align="center" style={{ flex: 1 }}>
        {showLogo && (
          <img
            src={`${import.meta.env.BASE_URL}favicon.png`}
            alt="Agor logo"
            style={{
              height: 32, // Smaller for mobile
              borderRadius: '50%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        )}

        <Title
          level={5}
          style={{
            margin: 0,
            color: '#fff',
            fontSize: showLogo ? 18 : 16,
            fontWeight: showLogo ? 400 : 500,
          }}
        >
          {title || 'agor'}
        </Title>
      </Space>

      <Space size={12} align="center">
        {user && (
          <div
            style={{
              fontSize: 20,
              lineHeight: 1,
            }}
          >
            {user.emoji || '👤'}
          </div>
        )}

        {showMenu && (
          <Button
            type="text"
            icon={<MenuOutlined />}
            onClick={onMenuClick}
            style={{ padding: '4px 8px', color: '#fff' }}
          />
        )}
      </Space>
    </Header>
  );
};
