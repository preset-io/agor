import type { User } from '@agor/core/types';
import { ArrowLeftOutlined, MenuOutlined, UserOutlined } from '@ant-design/icons';
import { Avatar, Button, Layout, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';

const { Header } = Layout;
const { Title } = Typography;

interface MobileHeaderProps {
  title: string;
  showBack?: boolean;
  showMenu?: boolean;
  user?: User | null;
  onMenuClick?: () => void;
  onLogout?: () => void;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({
  title,
  showBack = false,
  showMenu = true,
  user,
  onMenuClick,
  onLogout,
}) => {
  const navigate = useNavigate();

  return (
    <Header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        background: '#141414',
        borderBottom: '1px solid #303030',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        {showBack ? (
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate(-1)}
            style={{ padding: '4px 8px' }}
          />
        ) : showMenu ? (
          <Button
            type="text"
            icon={<MenuOutlined />}
            onClick={onMenuClick}
            style={{ padding: '4px 8px' }}
          />
        ) : null}
        <Title
          level={5}
          style={{
            margin: 0,
            color: 'rgba(255, 255, 255, 0.85)',
            fontSize: 16,
            fontWeight: 500,
          }}
        >
          {title}
        </Title>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {user && (
          <Avatar
            size="small"
            style={{
              backgroundColor: '#2e9a92',
              fontSize: 14,
            }}
          >
            {user.emoji || <UserOutlined />}
          </Avatar>
        )}
      </div>
    </Header>
  );
};
