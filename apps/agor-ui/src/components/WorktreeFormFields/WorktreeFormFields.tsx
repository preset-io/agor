/**
 * Reusable Worktree Form Fields
 *
 * Shared form fields for creating worktrees in both:
 * - NewSessionModal (create session with new worktree)
 * - WorktreesTable (create standalone worktree)
 */

import type { Board, Repo } from '@agor/core/types';
import { Checkbox, Form, Input, Select, Space, Typography } from 'antd';
import { useState } from 'react';

export interface WorktreeFormFieldsProps {
  repos: Repo[];
  boards?: Board[];
  selectedRepoId: string | null;
  onRepoChange: (repoId: string) => void;
  defaultBranch: string;
  /** Field name prefix (e.g., 'newWorktree_' for NewSessionModal) */
  fieldPrefix?: string;
  /** Show URL fields for issue/PR tracking */
  showUrlFields?: boolean;
  /** Show board selector */
  showBoardSelector?: boolean;
  /** Callback when form values change */
  onFormChange?: () => void;
  /** Controlled checkbox state */
  useSameBranchName?: boolean;
  /** Callback when checkbox changes */
  onUseSameBranchNameChange?: (checked: boolean) => void;
}

export const WorktreeFormFields: React.FC<WorktreeFormFieldsProps> = ({
  repos,
  boards = [],
  selectedRepoId,
  onRepoChange,
  defaultBranch,
  fieldPrefix = '',
  showUrlFields = false,
  showBoardSelector = false,
  onFormChange,
  useSameBranchName: controlledUseSameBranchName,
  onUseSameBranchNameChange,
}) => {
  const [internalUseSameBranchName, setInternalUseSameBranchName] = useState(true);

  // Use controlled or internal state
  const useSameBranchName = controlledUseSameBranchName ?? internalUseSameBranchName;
  const setUseSameBranchName = onUseSameBranchNameChange ?? setInternalUseSameBranchName;

  const form = Form.useFormInstance();

  const handleCheckboxChange = (checked: boolean) => {
    setUseSameBranchName(checked);
    // Clear branch name field when checkbox is checked
    if (checked) {
      form.setFieldValue(`${fieldPrefix}branchName`, undefined);
    }
    onFormChange?.();
  };

  return (
    <>
      <Form.Item
        name={`${fieldPrefix}repoId`}
        label="Repository"
        rules={[{ required: true, message: 'Please select a repository' }]}
        validateTrigger={['onBlur', 'onChange']}
      >
        <Select
          placeholder="Select repository..."
          showSearch
          filterOption={(input, option) =>
            (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
          }
          options={repos.map((repo) => ({
            value: repo.repo_id,
            label: repo.name || repo.slug,
          }))}
          onChange={onRepoChange}
        />
      </Form.Item>

      {showBoardSelector && (
        <Form.Item
          name={`${fieldPrefix}boardId`}
          label="Board (optional)"
          tooltip="Add this worktree to a board for organization"
        >
          <Select
            placeholder="Select board (optional)..."
            allowClear
            showSearch
            filterOption={(input, option) =>
              (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
            }
            options={boards.map((board) => ({
              value: board.board_id,
              label: `${board.icon || '📋'} ${board.name}`,
            }))}
            onChange={onFormChange}
          />
        </Form.Item>
      )}

      <Form.Item
        name={`${fieldPrefix}sourceBranch`}
        label="Source Branch"
        rules={[{ required: true, message: 'Please enter source branch' }]}
        validateTrigger={['onBlur', 'onChange']}
        tooltip="Branch to use as base for the new worktree branch"
        initialValue={defaultBranch}
      >
        <Input placeholder={defaultBranch} />
      </Form.Item>

      <Form.Item
        name={`${fieldPrefix}name`}
        label="Worktree Name"
        rules={[
          { required: true, message: 'Please enter a worktree name' },
          {
            pattern: /^[a-z0-9-]+$/,
            message: 'Only lowercase letters, numbers, and hyphens allowed',
          },
        ]}
        validateTrigger={['onBlur', 'onChange']}
        tooltip="URL-friendly name (e.g., 'feat-auth', 'fix-cors')"
      >
        <Input placeholder="feat-auth" autoFocus />
      </Form.Item>

      <Form.Item>
        <Checkbox
          checked={useSameBranchName}
          onChange={(e) => handleCheckboxChange(e.target.checked)}
        >
          Use worktree name as branch name
        </Checkbox>
      </Form.Item>

      {!useSameBranchName && (
        <Form.Item
          name={`${fieldPrefix}branchName`}
          label="Branch Name"
          rules={[{ required: true, message: 'Please enter branch name' }]}
          validateTrigger={['onBlur', 'onChange']}
        >
          <Input placeholder="feature/auth" />
        </Form.Item>
      )}

      {showUrlFields && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Form.Item
            name={`${fieldPrefix}issue_url`}
            label="Issue URL (optional)"
            rules={[
              {
                type: 'url',
                message: 'Please enter a valid URL',
              },
            ]}
            validateTrigger={['onBlur', 'onChange']}
          >
            <Input placeholder="https://github.com/org/repo/issues/123" />
          </Form.Item>

          <Form.Item
            name={`${fieldPrefix}pull_request_url`}
            label="Pull Request URL (optional)"
            rules={[
              {
                type: 'url',
                message: 'Please enter a valid URL',
              },
            ]}
            validateTrigger={['onBlur', 'onChange']}
          >
            <Input placeholder="https://github.com/org/repo/pull/123" />
          </Form.Item>
        </Space>
      )}

      <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
        <strong>What will happen:</strong>
        <br />• Fetch latest from origin
        <br />• Create new branch{' '}
        <Typography.Text code>
          {useSameBranchName ? '<worktree-name>' : '<branch-name>'}
        </Typography.Text>{' '}
        based on{' '}
        <Typography.Text code>
          {form.getFieldValue(`${fieldPrefix}sourceBranch`) || defaultBranch}
        </Typography.Text>
        <br />• Worktree location:{' '}
        <Typography.Text code>
          ~/.agor/worktrees/{'<repo>'}/<Typography.Text italic>{'<name>'}</Typography.Text>
        </Typography.Text>
      </Typography.Paragraph>
    </>
  );
};

// Export helper hook to get the branch name from form values
export const useWorktreeBranchName = (fieldPrefix = '') => {
  const form = Form.useFormInstance();
  const [useSameBranchName, setUseSameBranchName] = useState(true);

  const getBranchName = () => {
    const values = form.getFieldsValue();
    const name = values[`${fieldPrefix}name`];
    const branchName = values[`${fieldPrefix}branchName`];
    return useSameBranchName ? name : branchName;
  };

  return { useSameBranchName, setUseSameBranchName, getBranchName };
};
