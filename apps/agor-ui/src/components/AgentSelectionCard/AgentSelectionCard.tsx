import { Card, Space, Typography, theme } from 'antd';
import type { AgenticToolOption } from '../../types';
import { Tag } from '../Tag';
import { ToolIcon } from '../ToolIcon';

export interface AgentSelectionCardProps {
  agent: AgenticToolOption;
  selected?: boolean;
  onClick?: () => void;
}

export const AgentSelectionCard: React.FC<AgentSelectionCardProps> = ({
  agent,
  selected = false,
  onClick,
}) => {
  const { token } = theme.useToken();

  return (
    <Card
      hoverable
      onClick={onClick}
      style={{
        borderColor: selected ? token.colorPrimary : undefined,
        borderWidth: selected ? 2 : 1,
        cursor: 'pointer',
      }}
      styles={{
        body: { padding: 8 },
      }}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size={3}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} size={6}>
          <Space size={6}>
            <ToolIcon tool={agent.id} size={20} />
            <Typography.Text strong style={{ fontSize: '13px' }}>
              {agent.name}
            </Typography.Text>
            {agent.beta && <Tag color="warning">BETA</Tag>}
          </Space>
        </Space>

        {agent.version && (
          <Typography.Text type="secondary" style={{ fontSize: '10px' }}>
            Version: {agent.version}
          </Typography.Text>
        )}

        {agent.description && (
          <Typography.Text type="secondary" style={{ fontSize: '11px' }}>
            {agent.description}
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
};
