import type { Repo } from '@agor-live/client';
import { DownOutlined, InfoCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import {
  Alert,
  Checkbox,
  Collapse,
  Form,
  Input,
  Select,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { FormEmojiPickerInput } from '../EmojiPickerInput/EmojiPickerInput';

export interface TeammateFormFieldsProps {
  form: FormInstance;
  repos: Repo[];
  frameworkRepo: Repo | undefined;
  isCloning?: boolean;
  onDisplayNameChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  customRepoSelected: boolean;
  onCustomRepoChange: (selected: boolean) => void;
  /**
   * The board the create dialog was opened from, if any. Only when a current
   * board exists can the teammate be attached to it instead of getting its own
   * new board — on Home / global Settings this is empty, so the checkbox is
   * hidden and the teammate always gets a fresh board.
   */
  currentBoardId?: string;
  /** Optional section inserted before the repo/branch advanced settings collapse. */
  extraBeforeAdvanced?: React.ReactNode;
}

/**
 * Shared teammate form fields used by the CreateDialog Teammate tab.
 *
 * Renders: Name + icon, board placement control (new-board checkbox when a
 * current board exists, otherwise an own-board notice), Advanced collapse
 * (Framework Repository, Branch Name, Source Branch).
 * Does NOT render a <Form> wrapper — the parent owns the form instance.
 */
export const TeammateFormFields: React.FC<TeammateFormFieldsProps> = ({
  form,
  repos,
  frameworkRepo,
  isCloning,
  onDisplayNameChange,
  customRepoSelected,
  onCustomRepoChange,
  currentBoardId,
  extraBeforeAdvanced,
}) => {
  const { token } = theme.useToken();
  const repoPlaceholder = frameworkRepo
    ? `${frameworkRepo.name || frameworkRepo.slug} (default)`
    : isCloning
      ? 'Setting up framework repository...'
      : 'No framework repository found';

  return (
    <>
      <Form.Item label="Name" required tooltip="Human-friendly name and icon for this AI teammate">
        <Space.Compact style={{ display: 'flex' }}>
          <FormEmojiPickerInput form={form} fieldName="emoji" defaultEmoji="🤖" />
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

      {currentBoardId ? (
        <Form.Item name="createNewBoard" valuePropName="checked" initialValue={true}>
          <Checkbox>
            <Space direction="vertical" size={0}>
              <span>Create a new board for this teammate</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Uncheck to add the teammate to the current board instead of its own.
              </Typography.Text>
            </Space>
          </Checkbox>
        </Form.Item>
      ) : (
        <Alert
          type="info"
          showIcon={false}
          style={{ marginBottom: 16 }}
          title={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              This AI teammate gets its own fresh board and becomes that board&apos;s primary
              teammate.
            </Typography.Text>
          }
        />
      )}

      {extraBeforeAdvanced}

      {isCloning && !frameworkRepo && (
        <Alert
          type="info"
          showIcon
          icon={<LoadingOutlined />}
          style={{ marginBottom: 16 }}
          title="Setting up framework repository"
          description={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Cloning preset-io/agor-teammate. This usually takes 10-30 seconds.
            </Typography.Text>
          }
        />
      )}

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
                <Tooltip title="Teammates live in an Agor branch. These settings control the framework repository, branch name, and source branch used to create that teammate branch.">
                  <InfoCircleOutlined style={{ color: token.colorTextTertiary }} />
                </Tooltip>
              </Space>
            ),
            children: (
              <>
                <Form.Item name="repoId" label="Framework Repository">
                  <Select
                    placeholder={repoPlaceholder}
                    allowClear
                    showSearch
                    disabled={isCloning && !frameworkRepo}
                    filterOption={(input, option) =>
                      String(option?.label ?? '')
                        .toLowerCase()
                        .includes(input.toLowerCase())
                    }
                    options={[...repos]
                      .sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug))
                      .map((repo: Repo) => ({
                        value: repo.repo_id,
                        label: `${repo.name || repo.slug}${repo.repo_id === frameworkRepo?.repo_id ? ' (default)' : ''}`,
                      }))}
                    onChange={(value) => {
                      onCustomRepoChange(!!value && value !== frameworkRepo?.repo_id);
                    }}
                    onClear={() => onCustomRepoChange(false)}
                  />
                </Form.Item>

                {customRepoSelected && (
                  <Alert
                    type="warning"
                    showIcon
                    icon={<InfoCircleOutlined />}
                    style={{ marginBottom: 16 }}
                    title="Custom repository selected"
                    description={
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        The repository should be preset-io/agor-teammate or a fork/derivative. It
                        contains an OpenClaw-inspired agent framework adapted for Agor that your
                        teammate needs to operate. Legacy agor-assistant forks are still detected.
                      </Typography.Text>
                    }
                  />
                )}

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

                <Form.Item name="sourceBranch" label="Source Branch">
                  <Input placeholder="main" />
                </Form.Item>
              </>
            ),
          },
        ]}
      />
    </>
  );
};
