import { TEAMMATE_FRAMEWORK_REPO_URL } from '@agor-live/client';
import { DownOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import { Collapse, Form, Input, Select, Space, Tooltip, Typography, theme } from 'antd';
import { FormEmojiPickerInput } from '../EmojiPickerInput/EmojiPickerInput';

export interface TeammateFormFieldsProps {
  form: FormInstance;
  homeStep?: boolean;
  onDisplayNameChange: (e: React.ChangeEvent<HTMLInputElement>) => void;

  /** Optional section inserted after repository selection, before advanced branch settings. */
  extraBeforeAdvanced?: React.ReactNode;
}

/**
 * Shared teammate form fields used by the CreateDialog Teammate tab.
 *
 * Renders persona identity and advanced source/branch settings around the
 * caller-owned home selector. Hidden fields retain supported source choices.
 * Does NOT render a <Form> wrapper — the parent owns the form instance.
 */
export const TeammateFormFields: React.FC<TeammateFormFieldsProps> = ({
  form,
  homeStep,
  onDisplayNameChange,

  extraBeforeAdvanced,
}) => {
  const { token } = theme.useToken();
  return (
    <>
      <div hidden={homeStep} className="create-teammate-name">
        <Form.Item
          label="Name"
          required
          tooltip="Human-friendly name and icon for this AI teammate"
        >
          <Space.Compact style={{ display: 'flex' }}>
            <FormEmojiPickerInput fieldName="emoji" defaultEmoji="🤖" />
            <Form.Item
              name="displayName"
              noStyle
              rules={[{ required: true, message: 'Please enter a name' }]}
            >
              <Input
                placeholder="e.g. PR Reviewer, Command Center"
                autoFocus
                onChange={onDisplayNameChange}
                style={{ flex: 1 }}
              />
            </Form.Item>
          </Space.Compact>
        </Form.Item>
      </div>
      {extraBeforeAdvanced}
      <div hidden={homeStep} className="create-teammate-description">
        <Form.Item
          name="description"
          label="Description"
          tooltip="What does this AI teammate do? Visible to other agents via MCP."
        >
          <Input.TextArea
            placeholder="e.g. Reviews PRs and provides feedback, Monitors CI/CD pipelines"
            rows={2}
          />
        </Form.Item>
      </div>
      <div hidden={!homeStep}>
        <Collapse
          ghost
          size="small"
          destroyOnHidden={false}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'advanced',
              label: (
                <Space size={6}>
                  <Typography.Text type="secondary">Advanced Teammate Settings</Typography.Text>
                  <Tooltip title="Teammates live in an Agor branch. These settings control the branch name and source branch used to create that teammate branch.">
                    <InfoCircleOutlined style={{ color: token.colorTextTertiary }} />
                  </Tooltip>
                </Space>
              ),
              children: (
                <>
                  <Form.Item
                    name="name"
                    label="Branch Name"
                    rules={[
                      {
                        pattern: /^[a-z0-9-]+$/,
                        message: 'Only lowercase letters, numbers, and hyphens allowed',
                      },
                    ]}
                    tooltip="Auto-generated from display name. Override if needed."
                  >
                    <Input placeholder="private-my-teammate" />
                  </Form.Item>

                  <Form.Item
                    name="sourceRemoteUrl"
                    label="Starter source"
                    extra="Choose the canonical Agor starter or a branch already in your destination."
                  >
                    <Select
                      options={[
                        { value: TEAMMATE_FRAMEWORK_REPO_URL, label: 'Canonical Agor starter' },
                        { value: '', label: 'Destination’s own branch' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="sourceBranch" label="Source Branch">
                    <Input placeholder="main" />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
      </div>
    </>
  );
};
