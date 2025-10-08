import { GithubOutlined, MenuOutlined, SettingOutlined } from '@ant-design/icons';
import { Button, Layout, Space, Typography } from 'antd';

const { Header } = Layout;
const { Title, Text } = Typography;

export interface AppHeaderProps {
  onMenuClick?: () => void;
  onSettingsClick?: () => void;
  currentBoardName?: string;
  currentBoardIcon?: string;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  onMenuClick,
  onSettingsClick,
  currentBoardName,
  currentBoardIcon,
}) => {
  return (
    <Header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        background: '#001529',
      }}
    >
      <Space size={16} align="center">
        <img
          src="/favicon.png"
          alt="Agor logo"
          style={{
            height: 50,
            borderRadius: '50%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
        <Title level={3} style={{ margin: 0, color: '#fff' }}>
          agor
        </Title>
        {currentBoardName && (
          <Space
            size={4}
            align="center"
            style={{
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: 4,
              transition: 'background 0.2s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
            }}
            onClick={onMenuClick}
          >
            {currentBoardIcon && <span style={{ fontSize: 16 }}>{currentBoardIcon}</span>}
            <Text style={{ color: 'rgba(255, 255, 255, 0.65)', fontSize: 14 }}>
              {currentBoardName}
            </Text>
          </Space>
        )}
      </Space>

      <Space>
        <Button
          type="text"
          icon={<GithubOutlined />}
          href="https://github.com/maxtheman/agor"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#fff' }}
          title="View on GitHub"
        />
        <Button
          type="text"
          icon={<MenuOutlined />}
          onClick={onMenuClick}
          style={{ color: '#fff' }}
        />
        <Button
          type="text"
          icon={<SettingOutlined />}
          onClick={onSettingsClick}
          style={{ color: '#fff' }}
        />
      </Space>
    </Header>
  );
};
