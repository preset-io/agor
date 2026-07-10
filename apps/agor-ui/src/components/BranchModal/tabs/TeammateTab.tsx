import type { Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { RobotOutlined } from '@ant-design/icons';
import { Descriptions, Form, Input, Space, Typography } from 'antd';
import { EmojiPickerInput } from '../../EmojiPickerInput/EmojiPickerInput';
import { Tag } from '../../Tag';
import type { TeammateFormState } from '../useBranchModalForm';

interface TeammateTabProps {
  branch: Branch;
  canEdit: boolean;
  state: TeammateFormState;
  setField: <K extends keyof TeammateFormState>(key: K, value: TeammateFormState[K]) => void;
}

export const TeammateTab: React.FC<TeammateTabProps> = ({ branch, canEdit, state, setField }) => {
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
