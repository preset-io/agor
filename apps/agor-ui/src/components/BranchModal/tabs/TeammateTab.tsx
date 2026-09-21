import type { AgorClient, Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { RobotOutlined } from '@ant-design/icons';
import { Button, Descriptions, Form, Input, Popconfirm, Space, Typography } from 'antd';
import { useState } from 'react';
import { useConnectionDisabled } from '../../../contexts/ConnectionContext';
import { useThemedMessage } from '../../../utils/message';
import { EmojiPickerInput } from '../../EmojiPickerInput/EmojiPickerInput';
import { Tag } from '../../Tag';
import type { TeammateFormState } from '../useBranchModalForm';

interface TeammateTabProps {
  branch: Branch;
  client?: AgorClient | null;
  onRetired?: () => void;
  canEdit: boolean;
  state: TeammateFormState;
  setField: <K extends keyof TeammateFormState>(key: K, value: TeammateFormState[K]) => void;
}

export const TeammateTab: React.FC<TeammateTabProps> = ({
  branch,
  canEdit,
  state,
  setField,
  client,
  onRetired,
}) => {
  const [retiring, setRetiring] = useState(false);
  const disabled = useConnectionDisabled();
  const { showSuccess, showError } = useThemedMessage();
  const retire = async () => {
    if (!client) return;
    setRetiring(true);
    try {
      await client.service(`branches/${branch.branch_id}/retire-teammate`).create({});
      showSuccess('Teammate retired; files preserved');
      onRetired?.();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to retire teammate');
    } finally {
      setRetiring(false);
    }
  };
  const config = getTeammateConfig(branch);
  if (!config) return null;

  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <Space>
          {config.emoji ? (
            <span style={{ fontSize: 20 }}>{config.emoji}</span>
          ) : (
            <RobotOutlined style={{ fontSize: 20 }} />
          )}
          <Typography.Text strong style={{ fontSize: 16 }}>
            Teammate Configuration
          </Typography.Text>
        </Space>

        {/* Editable fields */}
        <Form layout="horizontal" colon={false}>
          <Form.Item label="Display Name" labelCol={{ span: 6 }} wrapperCol={{ span: 18 }}>
            <Input
              value={state.displayName}
              onChange={(e) => setField('displayName', e.target.value)}
              placeholder="Teammate display name"
              disabled={!canEdit}
            />
          </Form.Item>
          <Form.Item label="Icon" labelCol={{ span: 6 }} wrapperCol={{ span: 18 }}>
            <EmojiPickerInput
              value={state.emoji}
              onChange={(val) => setField('emoji', val)}
              defaultEmoji="🤖"
              disabled={!canEdit}
            />
          </Form.Item>
          <Form.Item
            label="Description"
            labelCol={{ span: 6 }}
            wrapperCol={{ span: 18 }}
            tooltip="What does this AI teammate do? Visible to other agents via MCP."
          >
            <Input.TextArea
              value={state.description}
              onChange={(e) => setField('description', e.target.value)}
              placeholder="What does this AI teammate do?"
              rows={2}
              disabled={!canEdit}
            />
          </Form.Item>
        </Form>

        {!branch.archived && (
          <Popconfirm
            title="Retire teammate?"
            description="Archives this teammate and clears personal primary preferences. Files are preserved. Reassign any board primary first."
            onConfirm={retire}
          >
            <Button danger disabled={!canEdit || !client || disabled} loading={retiring}>
              Retire teammate
            </Button>
          </Popconfirm>
        )}

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
      </Space>
    </div>
  );
};
