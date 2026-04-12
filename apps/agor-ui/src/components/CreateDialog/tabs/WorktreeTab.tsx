import type { Repo } from '@agor-live/client';
import { Form } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { WorktreeFormFields } from '../../WorktreeFormFields';

export interface WorktreeTabConfig {
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
}

export interface WorktreeTabProps {
  repoById: Map<string, Repo>;
  currentBoardId?: string;
  defaultPosition?: { x: number; y: number };
  onValidityChange: (valid: boolean) => void;
  formRef: React.MutableRefObject<(() => Promise<WorktreeTabConfig | null>) | null>;
}

export const WorktreeTab: React.FC<WorktreeTabProps> = ({
  repoById,
  currentBoardId,
  defaultPosition,
  onValidityChange,
  formRef,
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

  // Remember last used repo
  useEffect(() => {
    if (repoById.size === 0) return;

    const lastRepoId = localStorage.getItem('agor-last-repo-id');
    if (lastRepoId && repoById.has(lastRepoId)) {
      form.setFieldsValue({
        repoId: lastRepoId,
        sourceBranch: repoById.get(lastRepoId)?.default_branch,
      });
      setSelectedRepoId(lastRepoId);
      handleValuesChange();
    } else if (repoById.size > 0) {
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
      const config: WorktreeTabConfig = {
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
      <WorktreeFormFields
        repoById={repoById}
        selectedRepoId={selectedRepoId}
        onRepoChange={handleRepoChange}
        defaultBranch={selectedRepo?.default_branch || 'main'}
        showUrlFields={true}
        onFormChange={handleValuesChange}
      />
    </Form>
  );
};
