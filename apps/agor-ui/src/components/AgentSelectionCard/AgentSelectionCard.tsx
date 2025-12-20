import { Card, Space, Typography } from 'antd';
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
  return (
    <Card
      hoverable
      onClick={onClick}
      style={{
        borderColor: selected ? '#1890ff' : undefined,
        borderWidth: selected ? 2 : 1,
        cursor: 'pointer',
      }}
      styles={{
        body: { padding: 12 },
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} size={8}>
          <Space size={8}>
            <ToolIcon tool={agent.id} size={24} />
            <Typography.Text strong style={{ fontSize: '14px' }}>
              {agent.name}
            </Typography.Text>
            {agent.beta && <Tag color="warning">BETA</Tag>}
          </Space>
        </Space>

        {agent.version && (
          <Typography.Text type="secondary" style={{ fontSize: '11px' }}>
            Version: {agent.version}
          </Typography.Text>
        )}

        {agent.description && (
          <Typography.Text type="secondary" style={{ fontSize: '12px' }}>
            {agent.description}
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
};
