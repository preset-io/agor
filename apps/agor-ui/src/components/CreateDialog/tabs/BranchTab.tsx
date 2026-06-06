import type { Repo } from '@agor-live/client';
import { Form } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import { normalizeBranchStorageMode } from '@/utils/branchStorage';
import { mapToArray } from '@/utils/mapHelpers';
import { BranchFormFields } from '../../BranchFormFields';

export interface BranchTabConfig {
  repoId: string;
  name: string;
  ref: string;
  refType?: 'branch' | 'tag';
  createBranch: boolean;
  sourceBranch: string;
  pullLatest: boolean;
  issue_url?: string;
  pull_request_url?: string;
  board_id?: string;
  position?: { x: number; y: number };
  /**
   * Branch storage model. 'worktree' = legacy `git worktree add`. 'clone' =
   * self-standing `git clone`. Default 'branch' preserves existing flow.
   * See context/explorations/clone-redesign.md.
   */
  storage_mode?: 'worktree' | 'clone';
  /** Shallow-clone depth — only meaningful when storage_mode='clone'. */
  clone_depth?: number;
}

export interface BranchTabProps {
  repoById: Map<string, Repo>;
  currentBoardId?: string;
  defaultPosition?: { x: number; y: number };
  onValidityChange: (valid: boolean) => void;
  formRef: React.MutableRefObject<(() => Promise<BranchTabConfig | null>) | null>;
  branchStorageConfig?: BranchStorageConfig;
}

export const BranchTab: React.FC<BranchTabProps> = ({
  repoById,
  currentBoardId,
  defaultPosition,
  onValidityChange,
  formRef,
  branchStorageConfig,
}) => {
  const [form] = Form.useForm();
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);

  const selectedRepo = selectedRepoId ? repoById.get(selectedRepoId) : undefined;

  const handleValuesChange = useCallback(() => {
    setTimeout(() => {
      const values = form.getFieldsValue();
      const isValid = !!(values.repoId && values.sourceBranch && values.name);
      onValidityChange(isValid);
    }, 0);
  }, [form, onValidityChange]);

  // Initialize form once per mount. Without this guard the effect re-fires
  // on every `repos.patched` WebSocket event (which gives `repoById` a new
  // Map reference), and `setFieldsValue({ sourceBranch })` silently
  // overwrites whatever the user typed back to the repo's default branch.
  // The user notices only after submitting that the branch got created
  // off `main` instead of their chosen branch.
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || repoById.size === 0) return;

    const lastRepoId = localStorage.getItem('agor-last-repo-id');
    if (lastRepoId && repoById.has(lastRepoId)) {
      initialized.current = true;
      form.setFieldsValue({
        repoId: lastRepoId,
        sourceBranch: repoById.get(lastRepoId)?.default_branch,
      });
      setSelectedRepoId(lastRepoId);
      handleValuesChange();
    } else if (repoById.size > 0) {
      initialized.current = true;
      const firstRepo = mapToArray(repoById)[0];
      form.setFieldsValue({
        repoId: firstRepo.repo_id,
        sourceBranch: firstRepo.default_branch,
      });
      setSelectedRepoId(firstRepo.repo_id);
      handleValuesChange();
    }
  }, [repoById, form, handleValuesChange]);

  const handleRepoChange = (repoId: string) => {
    setSelectedRepoId(repoId);
    const repo = repoById.get(repoId);
    if (repo?.default_branch) {
      form.setFieldValue('sourceBranch', repo.default_branch);
    }
  };

  // Expose submit function via ref
  formRef.current = async () => {
    try {
      const values = await form.validateFields();
      const refType = values.refType || 'branch';
      const storageMode = normalizeBranchStorageMode(values.storage_mode, branchStorageConfig);
      const cloneDepth =
        storageMode === 'clone' && typeof values.clone_depth === 'number' && values.clone_depth > 0
          ? values.clone_depth
          : undefined;
      const config: BranchTabConfig = {
        repoId: values.repoId,
        name: values.name,
        ref: values.name,
        refType,
        createBranch: true,
        sourceBranch: values.sourceBranch || selectedRepo?.default_branch || 'main',
        pullLatest: true,
        issue_url: values.issue_url,
        pull_request_url: values.pull_request_url,
        board_id: currentBoardId,
        position: defaultPosition,
        storage_mode: storageMode,
        ...(cloneDepth !== undefined ? { clone_depth: cloneDepth } : {}),
      };

      if (values.repoId) {
        localStorage.setItem('agor-last-repo-id', values.repoId);
      }

      return config;
    } catch {
      return null;
    }
  };

  return (
    <Form form={form} layout="vertical" onValuesChange={handleValuesChange}>
      <BranchFormFields
        repoById={repoById}
        selectedRepoId={selectedRepoId}
        onRepoChange={handleRepoChange}
        defaultBranch={selectedRepo?.default_branch || 'main'}
        showUrlFields={true}
        onFormChange={handleValuesChange}
        branchStorageConfig={branchStorageConfig}
      />
    </Form>
  );
};
