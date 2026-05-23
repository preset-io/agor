/**
 * Reusable Worktree Form Fields
 *
 * Shared form fields for creating worktrees in both:
 * - NewSessionModal (create session with new worktree)
 * - BranchesTable (create standalone worktree)
 */

import type { Board, Repo } from '@agor-live/client';
import { Checkbox, Form, Input, InputNumber, Radio, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';

/**
 * Default depth pre-filled into the "Depth" input when the user selects
 * Branch storage. A small positive number is the right default: shallow
 * clones drop a lot of disk overhead with negligible UX cost for typical
 * feature branches. The user can clear the field for a full clone or set
 * a different positive integer.
 */
const DEFAULT_CLONE_DEPTH = 100;

export interface BranchFormFieldsProps {
  repoById: Map<string, Repo>;
  boardById?: Map<string, Board>;
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

export const BranchFormFields: React.FC<BranchFormFieldsProps> = ({
  repoById,
  boardById = new Map(),
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
  const [refType, setRefType] = useState<'branch' | 'tag'>('branch');

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
            String(option?.label ?? '')
              .toLowerCase()
              .includes(input.toLowerCase())
          }
          options={mapToArray(repoById)
            .sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug))
            .map((repo: Repo) => ({
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
          tooltip="Add this branch to a board for organization"
        >
          <Select
            placeholder="Select board (optional)..."
            allowClear
            showSearch
            filterOption={(input, option) =>
              String(option?.label ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
            options={mapToArray(boardById)
              .sort((a: Board, b: Board) => a.name.localeCompare(b.name))
              .map((board: Board) => ({
                value: board.board_id,
                label: `${board.icon || '📋'} ${board.name}`,
              }))}
            onChange={onFormChange}
          />
        </Form.Item>
      )}

      <Form.Item name={`${fieldPrefix}refType`} label="Source Type" initialValue="branch">
        <Radio.Group
          onChange={(e) => {
            setRefType(e.target.value);
            // Clear sourceBranch when switching to tag
            if (e.target.value === 'tag') {
              form.setFieldValue(`${fieldPrefix}sourceBranch`, undefined);
            } else {
              form.setFieldValue(`${fieldPrefix}sourceBranch`, defaultBranch);
            }
            onFormChange?.();
          }}
        >
          <Radio value="branch">Branch</Radio>
          <Radio value="tag">Tag</Radio>
        </Radio.Group>
      </Form.Item>

      <Form.Item
        name={`${fieldPrefix}sourceBranch`}
        label={refType === 'branch' ? 'Source Branch' : 'Source Tag'}
        rules={[{ required: true, message: `Please enter source ${refType}` }]}
        validateTrigger={['onBlur', 'onChange']}
        tooltip={`${refType} to use as base for the new branch`}
        initialValue={defaultBranch}
      >
        <Input placeholder={refType === 'branch' ? defaultBranch : 'v1.0.0'} />
      </Form.Item>

      <Form.Item
        name={`${fieldPrefix}name`}
        label="Branch Name"
        rules={[
          { required: true, message: 'Please enter a branch name' },
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
          {refType === 'tag'
            ? 'Use the same name for the git branch (new branch from tag)'
            : 'Use the same name for the git branch'}
        </Checkbox>
      </Form.Item>

      {!useSameBranchName && (
        <Form.Item
          name={`${fieldPrefix}branchName`}
          label="Git Branch Name"
          rules={[{ required: true, message: 'Please enter a git branch name' }]}
          validateTrigger={['onBlur', 'onChange']}
        >
          <Input placeholder="feature/auth" />
        </Form.Item>
      )}

      <Form.Item
        name={`${fieldPrefix}storage_mode`}
        label="Storage"
        initialValue="worktree"
        tooltip={
          'How the branch is materialised on disk. ' +
          '"Worktree" uses git\'s native shared-base model (legacy default). ' +
          '"Branch" gives this worktree its own .git/ directory via a real ' +
          'git clone — credentials and config are isolated from sibling branches. ' +
          'See docs/internal/branch-vs-worktree-migration-analysis-2026-05-20.md.'
        }
      >
        <Radio.Group onChange={() => onFormChange?.()}>
          <Radio value="worktree">Worktree (default)</Radio>
          <Radio value="clone">Branch</Radio>
        </Radio.Group>
      </Form.Item>

      {/*
        Depth input: only visible when "Branch" is selected. Pre-fills with
        DEFAULT_CLONE_DEPTH on render so the common shallow case is one click
        away; clearing the field means "full clone" (no --depth flag). Uses
        `shouldUpdate` so the parent form only re-renders this branch when
        the storage_mode field actually changes.
      */}
      <Form.Item
        shouldUpdate={(prev, curr) =>
          prev[`${fieldPrefix}storage_mode`] !== curr[`${fieldPrefix}storage_mode`]
        }
        noStyle
      >
        {({ getFieldValue }) =>
          getFieldValue(`${fieldPrefix}storage_mode`) === 'clone' ? (
            <Form.Item
              name={`${fieldPrefix}clone_depth`}
              label="Depth"
              initialValue={DEFAULT_CLONE_DEPTH}
              tooltip={
                'Number of commits to keep (`git clone --depth N`). ' +
                'Defaults to 100 — usually plenty for a feature branch. ' +
                'Leave empty for a full clone with complete history.'
              }
              rules={[
                {
                  validator: (_rule, value) => {
                    // Empty / null → full clone (handled at submit time).
                    if (value === undefined || value === null || value === '') {
                      return Promise.resolve();
                    }
                    if (Number.isInteger(value) && value > 0) {
                      return Promise.resolve();
                    }
                    return Promise.reject(
                      new Error('Depth must be a positive integer, or empty for a full clone')
                    );
                  },
                },
              ]}
            >
              <InputNumber
                min={1}
                placeholder="100"
                style={{ width: 160 }}
                onChange={() => onFormChange?.()}
              />
            </Form.Item>
          ) : null
        }
      </Form.Item>

      {showUrlFields && (
        <Space orientation="vertical" style={{ width: '100%' }}>
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
        <Typography.Text code>{useSameBranchName ? '<name>' : '<git-branch-name>'}</Typography.Text>{' '}
        based on {refType === 'tag' ? 'tag' : 'branch'}{' '}
        <Typography.Text code>
          {form.getFieldValue(`${fieldPrefix}sourceBranch`) ||
            (refType === 'tag' ? '<tag-name>' : defaultBranch)}
        </Typography.Text>
        <br />• Branch location:{' '}
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
