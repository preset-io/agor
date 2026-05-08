import type { Repo } from '@agor-live/client';
import { Button, Form, Modal } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import type { WorktreeTabConfig } from '../CreateDialog/tabs/WorktreeTab';
import { WorktreeFormFields } from '../WorktreeFormFields';

/** @deprecated Use WorktreeTabConfig directly. Kept as alias for backward compat. */
export type NewWorktreeConfig = WorktreeTabConfig;

export interface NewWorktreeModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (config: NewWorktreeConfig) => void;
  repoById: Map<string, Repo>;
  currentBoardId?: string; // Auto-fill board if provided
  defaultPosition?: { x: number; y: number }; // Default position on canvas (center of viewport)
}

export const NewWorktreeModal: React.FC<NewWorktreeModalProps> = ({
  open,
  onClose,
  onCreate,
  repoById,
  currentBoardId,
  defaultPosition,
}) => {
  const [form] = Form.useForm();
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [isFormValid, setIsFormValid] = useState(false);

  const selectedRepo = selectedRepoId ? repoById.get(selectedRepoId) : undefined;

  // Form validation handler
  const handleValuesChange = useCallback(() => {
    // Use setTimeout to ensure we're checking after the form state has updated
    setTimeout(() => {
      const values = form.getFieldsValue();

      // Check if required fields are filled
      const isValid = !!(values.repoId && values.sourceBranch && values.name);
      setIsFormValid(isValid);
    }, 0);
  }, [form]);

  // Initialize form once per modal-open session. Without this guard the
  // effect re-fires on every `repos.patched` WebSocket event (which gives
  // `repoById` a new Map reference), and `setFieldsValue({ sourceBranch })`
  // silently overwrites whatever the user typed back to the repo's default
  // branch. The user notices only after submitting that the worktree got
  // created off `main` instead of their chosen branch.
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    if (initialized.current || repoById.size === 0) return;

    const lastRepoId = localStorage.getItem('agor-last-repo-id');

    // If we have a last used repo and it still exists, use it
    if (lastRepoId && repoById.has(lastRepoId)) {
      initialized.current = true;
      form.setFieldsValue({
        repoId: lastRepoId,
        sourceBranch: repoById.get(lastRepoId)?.default_branch,
      });
      setSelectedRepoId(lastRepoId);
      // Trigger validation check
      handleValuesChange();
    } else if (repoById.size > 0) {
      // No last-repo-id or it doesn't exist anymore - auto-select first repo
      initialized.current = true;
      const firstRepo = mapToArray(repoById)[0];
      form.setFieldsValue({
        repoId: firstRepo.repo_id,
        sourceBranch: firstRepo.default_branch,
      });
      setSelectedRepoId(firstRepo.repo_id);
      // Trigger validation check
      handleValuesChange();
    }
  }, [open, repoById, form, handleValuesChange]);

  const handleRepoChange = (repoId: string) => {
    setSelectedRepoId(repoId);

    // Auto-populate source branch from repo's default branch
    const repo = repoById.get(repoId);
    if (repo?.default_branch) {
      form.setFieldValue('sourceBranch', repo.default_branch);
    }
  };

  const handleCreate = async () => {
    const values = await form.validateFields();

    const refType = values.refType || 'branch';
    const config: NewWorktreeConfig = {
      repoId: values.repoId,
      name: values.name,
      ref: values.name, // Use worktree name as ref (branch name)
      refType,
      createBranch: true,
      sourceBranch: values.sourceBranch || selectedRepo?.default_branch || 'main',
      pullLatest: true,
      issue_url: values.issue_url,
      pull_request_url: values.pull_request_url,
      board_id: currentBoardId, // Include board_id if provided
      position: defaultPosition, // Include position if provided
    };

    // Remember last used repo
    if (values.repoId) {
      localStorage.setItem('agor-last-repo-id', values.repoId);
    }

    onCreate(config);
    onClose();

    // Reset form
    form.resetFields();
    setSelectedRepoId(null);
    setIsFormValid(false);
  };

  const handleCancel = () => {
    onClose();
    form.resetFields();
    setSelectedRepoId(null);
    setIsFormValid(false);
  };

  return (
    <Modal
      title="Create New Worktree"
      open={open}
      onCancel={handleCancel}
      width={700}
      footer={[
        <Button key="cancel" onClick={handleCancel}>
          Cancel
        </Button>,
        <Button key="create" type="primary" onClick={handleCreate} disabled={!isFormValid}>
          Create Worktree
        </Button>,
      ]}
    >
      <Form
        form={form}
        layout="vertical"
        onValuesChange={handleValuesChange}
        style={{ marginTop: 24 }}
      >
        <WorktreeFormFields
          repoById={repoById}
          selectedRepoId={selectedRepoId}
          onRepoChange={handleRepoChange}
          defaultBranch={selectedRepo?.default_branch || 'main'}
          showUrlFields={true}
          onFormChange={handleValuesChange}
        />
      </Form>
    </Modal>
  );
};
