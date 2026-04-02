import type { Board, Repo } from '@agor/core/types';
import { InfoCircleOutlined, LoadingOutlined, SettingOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import { Alert, Collapse, Form, Input, Select, Space, Typography } from 'antd';
import { CREATE_NEW_BOARD } from '@/utils/assistantConstants';
import { FormEmojiPickerInput } from '../EmojiPickerInput/EmojiPickerInput';

export { CREATE_NEW_BOARD };

export interface AssistantFormFieldsProps {
  form: FormInstance;
  repos: Repo[];
  boards: Board[];
  frameworkRepo: Repo | undefined;
  isCloning?: boolean;
  onDisplayNameChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  customRepoSelected: boolean;
  onCustomRepoChange: (selected: boolean) => void;
}

/**
 * Shared assistant form fields used in both the CreateDialog AssistantTab
 * and the SettingsModal AssistantsTable create modal.
 *
 * Renders: Display Name, Icon, Board, board advice Alert, Advanced collapse
 * (Framework Repository, Worktree Name, Source Branch).
 * Does NOT render a <Form> wrapper — the parent owns the form instance.
 */
export const AssistantFormFields: React.FC<AssistantFormFieldsProps> = ({
  form,
  repos,
  boards,
  frameworkRepo,
  isCloning,
  onDisplayNameChange,
  customRepoSelected,
  onCustomRepoChange,
}) => {
  const boardOptions = [
    {
      value: CREATE_NEW_BOARD,
      label: '+ Create a new board for this assistant (Recommended)',
    },
    ...[...boards]
      .sort((a: Board, b: Board) => a.name.localeCompare(b.name))
      .map((board: Board) => ({
        value: board.board_id,
        label: `${board.icon || '\u{1F4CB}'} ${board.name}`,
      })),
  ];

  const repoPlaceholder = frameworkRepo
    ? `${frameworkRepo.name || frameworkRepo.slug} (default)`
    : isCloning
      ? 'Setting up framework repository...'
      : 'No framework repository found';

  return (
    <>
      <Form.Item
        name="displayName"
        label="Display Name"
        rules={[{ required: true, message: 'Please enter a display name' }]}
        tooltip="Human-friendly name for this assistant"
      >
        <Input
          placeholder="e.g. PR Reviewer, Command Center"
          autoFocus
          onChange={onDisplayNameChange}
        />
      </Form.Item>

      <Form.Item name="emoji" label="Icon">
        <FormEmojiPickerInput form={form} fieldName="emoji" defaultEmoji="\u{1F916}" />
      </Form.Item>

      <Form.Item
        name="description"
        label="Description"
        tooltip="What does this assistant do? Visible to other agents via MCP."
      >
        <Input.TextArea
          placeholder="e.g. Reviews PRs and provides feedback, Monitors CI/CD pipelines"
          rows={2}
        />
      </Form.Item>

      <Form.Item name="boardChoice" label="Board">
        <Select
          showSearch
          filterOption={(input, option) =>
            String(option?.label ?? '')
              .toLowerCase()
              .includes(input.toLowerCase())
          }
          options={boardOptions}
        />
      </Form.Item>

      <Alert
        type="info"
        showIcon={false}
        style={{ marginBottom: 16 }}
        message={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            While assistants can act across boards, we recommend giving each assistant its own
            board.
          </Typography.Text>
        }
      />

      {isCloning && !frameworkRepo && (
        <Alert
          type="info"
          showIcon
          icon={<LoadingOutlined />}
          style={{ marginBottom: 16 }}
          message="Setting up framework repository"
          description={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Cloning preset-io/agor-assistant. This usually takes 10-30 seconds.
            </Typography.Text>
          }
        />
      )}

      <Collapse
        ghost
        size="small"
        destroyOnHidden={false}
        items={[
          {
            key: 'advanced',
            label: (
              <Space>
                <SettingOutlined />
                <Typography.Text type="secondary">Advanced</Typography.Text>
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
                    message="Custom repository selected"
                    description={
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        The repository should be preset-io/agor-assistant or a fork/derivative. It
                        contains an OpenClaw-inspired agent framework adapted for Agor that your
                        assistant needs to operate.
                      </Typography.Text>
                    }
                  />
                )}

                <Form.Item
                  name="name"
                  label="Worktree Name"
                  rules={[
                    {
                      pattern: /^[a-z0-9-]+$/,
                      message: 'Only lowercase letters, numbers, and hyphens allowed',
                    },
                  ]}
                  tooltip="Auto-generated from display name. Override if needed."
                >
                  <Input placeholder="private-my-assistant" />
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
