import type { Board, Repo } from '@agor/core/types';
import { InfoCircleOutlined, SettingOutlined } from '@ant-design/icons';
import { Alert, Collapse, Form, Input, Select, Space, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { FormEmojiPickerInput } from '../../EmojiPickerInput/EmojiPickerInput';

const FRAMEWORK_REPO_SLUG = 'preset-io/agor-assistant';
const CREATE_NEW_BOARD = '__create_new__';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface AssistantTabResult {
  displayName: string;
  emoji?: string;
  boardChoice?: string;
  repoId?: string;
  worktreeName?: string;
  sourceBranch?: string;
}

export interface AssistantTabProps {
  repoById: Map<string, Repo>;
  boardById: Map<string, Board>;
  onValidityChange: (valid: boolean) => void;
  formRef: React.MutableRefObject<(() => Promise<AssistantTabResult | null>) | null>;
}

export const AssistantTab: React.FC<AssistantTabProps> = ({
  repoById,
  boardById,
  onValidityChange,
  formRef,
}) => {
  const repos = mapToArray(repoById);
  const boards = mapToArray(boardById);
  const [form] = Form.useForm();
  const [customRepoSelected, setCustomRepoSelected] = useState(false);
  const lastAutoName = useRef('');

  const frameworkRepo = useMemo(
    () =>
      repos.find(
        (r) =>
          r.slug === FRAMEWORK_REPO_SLUG ||
          r.remote_url?.includes('agor-assistant') ||
          r.remote_url?.includes('agor-openclaw')
      ),
    [repos]
  );

  useEffect(() => {
    if (frameworkRepo && !form.getFieldValue('repoId')) {
      form.setFieldValue('repoId', frameworkRepo.repo_id);
    }
  }, [frameworkRepo, form]);

  const validateForm = useCallback(() => {
    const values = form.getFieldsValue();
    const hasDisplayName = !!values.displayName?.trim();
    const hasRepo = Boolean(values.repoId || frameworkRepo?.repo_id);
    onValidityChange(hasDisplayName && hasRepo);
  }, [form, frameworkRepo, onValidityChange]);

  const handleDisplayNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const displayName = e.target.value;
    const currentName = form.getFieldValue('name');
    const autoName = `private-${slugify(displayName)}`;
    if (!currentName || currentName === lastAutoName.current) {
      form.setFieldValue('name', autoName);
      lastAutoName.current = autoName;
    }
    validateForm();
  };

  formRef.current = async () => {
    try {
      const values = await form.validateFields();
      return {
        displayName: values.displayName.trim(),
        emoji: values.emoji || undefined,
        boardChoice: values.boardChoice,
        repoId: values.repoId || frameworkRepo?.repo_id,
        worktreeName: values.name || `private-${slugify(values.displayName)}`,
        sourceBranch: values.sourceBranch || 'main',
      };
    } catch {
      return null;
    }
  };

  const boardOptions = [
    {
      value: CREATE_NEW_BOARD,
      label: '+ Create a new board for this assistant (Recommended)',
    },
    ...boards.map((board: Board) => ({
      value: board.board_id,
      label: `${board.icon || '\u{1F4CB}'} ${board.name}`,
    })),
  ];

  return (
    <Form
      form={form}
      layout="vertical"
      onFieldsChange={validateForm}
      initialValues={{ boardChoice: CREATE_NEW_BOARD, sourceBranch: 'main' }}
    >
      <Form.Item
        name="displayName"
        label="Display Name"
        rules={[{ required: true, message: 'Please enter a display name' }]}
        tooltip="Human-friendly name for this assistant"
      >
        <Input
          placeholder="e.g. PR Reviewer, Command Center"
          autoFocus
          onChange={handleDisplayNameChange}
        />
      </Form.Item>

      <Form.Item name="emoji" label="Icon">
        <FormEmojiPickerInput form={form} fieldName="emoji" defaultEmoji="\u{1F916}" />
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

      <Collapse
        ghost
        size="small"
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
                    placeholder={
                      frameworkRepo
                        ? `${frameworkRepo.name || frameworkRepo.slug} (default)`
                        : 'Registering preset-io/agor-assistant...'
                    }
                    allowClear
                    showSearch
                    filterOption={(input, option) =>
                      String(option?.label ?? '')
                        .toLowerCase()
                        .includes(input.toLowerCase())
                    }
                    options={repos
                      .sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug))
                      .map((repo: Repo) => ({
                        value: repo.repo_id,
                        label: `${repo.name || repo.slug}${repo.repo_id === frameworkRepo?.repo_id ? ' (default)' : ''}`,
                      }))}
                    onChange={(value) => {
                      setCustomRepoSelected(!!value && value !== frameworkRepo?.repo_id);
                    }}
                    onClear={() => setCustomRepoSelected(false)}
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
                        The repository should be preset-io/agor-assistant or a fork/derivative.
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
    </Form>
  );
};
