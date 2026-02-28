import type { PersistedAgentConfig, Worktree } from '@agor/core/types';
import { getPersistedAgentConfig } from '@agor/core/types';
import { RobotOutlined } from '@ant-design/icons';
import { Button, Descriptions, Form, Input, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '../../../utils/message';
import { Tag } from '../../Tag';
import type { WorktreeUpdate } from './GeneralTab';

interface AgentTabProps {
  worktree: Worktree;
  onUpdate?: (worktreeId: string, updates: WorktreeUpdate) => void;
  onClose?: () => void;
}

export const AgentTab: React.FC<AgentTabProps> = ({ worktree, onUpdate, onClose }) => {
  const config = getPersistedAgentConfig(worktree);
  const { showSuccess } = useThemedMessage();

  const [displayName, setDisplayName] = useState(config?.displayName || '');
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    if (!isInitialized) {
      setDisplayName(config?.displayName || '');
      setIsInitialized(true);
    }
  }, [isInitialized, config?.displayName]);

  if (!config) return null;

  const hasChanges = displayName.trim() !== config.displayName;

  const handleSave = () => {
    const updatedConfig: PersistedAgentConfig = {
      ...config,
      displayName: displayName.trim(),
    };
    onUpdate?.(worktree.worktree_id, {
      custom_context: { agent: updatedConfig },
    });
    showSuccess('Agent updated');
    onClose?.();
  };

  const handleCancel = () => {
    setDisplayName(config.displayName);
  };

  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Space>
          <RobotOutlined style={{ fontSize: 20 }} />
          <Typography.Text strong style={{ fontSize: 16 }}>
            Agent Configuration
          </Typography.Text>
        </Space>

        {/* Editable fields */}
        <Form layout="horizontal" colon={false}>
          <Form.Item label="Display Name" labelCol={{ span: 6 }} wrapperCol={{ span: 18 }}>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Agent display name"
            />
          </Form.Item>
        </Form>

        {/* Read-only metadata */}
        <Descriptions column={1} bordered size="small">
          {config.frameworkRepo && (
            <Descriptions.Item label="Framework Repo">
              <Typography.Text code>{config.frameworkRepo}</Typography.Text>
            </Descriptions.Item>
          )}
          {config.frameworkVersion && (
            <Descriptions.Item label="Framework Version">
              <Typography.Text code>{config.frameworkVersion}</Typography.Text>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Created via">
            {config.createdViaOnboarding ? (
              <Tag color="blue">Onboarding Wizard</Tag>
            ) : (
              <Tag>Manual</Tag>
            )}
          </Descriptions.Item>
        </Descriptions>

        {/* Actions */}
        <Space>
          <Button type="primary" onClick={handleSave} disabled={!hasChanges}>
            Save Changes
          </Button>
          <Button onClick={handleCancel} disabled={!hasChanges}>
            Cancel
          </Button>
        </Space>
      </Space>
    </div>
  );
};
