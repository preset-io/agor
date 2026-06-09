import { InfoCircleOutlined } from '@ant-design/icons';
import { Popover, Space, Typography, theme } from 'antd';
import type React from 'react';

const { Title } = Typography;

export const HomeSectionHeader: React.FC<{
  title: string;
  icon?: React.ReactNode;
  info?: React.ReactNode;
  extra?: React.ReactNode;
}> = ({ title, icon, info, extra }) => {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 12,
      }}
    >
      <Space size={8}>
        {icon}
        <Title level={4} style={{ margin: 0 }}>
          {title}
        </Title>
        {info && (
          <Popover
            content={<div style={{ maxWidth: 320 }}>{info}</div>}
            trigger="hover"
            placement="rightTop"
          >
            <InfoCircleOutlined style={{ color: token.colorTextTertiary, cursor: 'help' }} />
          </Popover>
        )}
      </Space>
      {extra}
    </div>
  );
};
