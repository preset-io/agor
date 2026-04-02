import type { Board, Repo } from '@agor/core/types';
import { Form } from 'antd';
import { useEffect } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { slugify } from '@/utils/repoSlug';
import { useAssistantForm } from '../../../hooks/useAssistantForm';
import { useEnsureFrameworkRepo } from '../../../hooks/useEnsureFrameworkRepo';
import { AssistantFormFields, CREATE_NEW_BOARD } from '../../forms/AssistantFormFields';

export interface AssistantTabResult {
  displayName: string;
  description?: string;
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
  onCreateRepo?: (data: { url: string; slug: string; default_branch: string }) => void;
}

export const AssistantTab: React.FC<AssistantTabProps> = ({
  repoById,
  boardById,
  onValidityChange,
  formRef,
  onCreateRepo,
}) => {
  const repos = mapToArray(repoById);
  const boards = mapToArray(boardById);
  const { frameworkRepo, isCloning } = useEnsureFrameworkRepo(repos, onCreateRepo);

  const {
    form,
    isFormValid,
    customRepoSelected,
    setCustomRepoSelected,
    validateForm,
    handleDisplayNameChange,
  } = useAssistantForm(frameworkRepo);

  // Sync form validity to parent
  useEffect(() => {
    onValidityChange(isFormValid);
  }, [isFormValid, onValidityChange]);

  formRef.current = async () => {
    try {
      const values = await form.validateFields();
      return {
        displayName: values.displayName.trim(),
        description: values.description || undefined,
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

  return (
    <Form
      form={form}
      layout="vertical"
      onFieldsChange={validateForm}
      initialValues={{ boardChoice: CREATE_NEW_BOARD, sourceBranch: 'main' }}
    >
      <AssistantFormFields
        form={form}
        repos={repos}
        boards={boards}
        frameworkRepo={frameworkRepo}
        isCloning={isCloning}
        onDisplayNameChange={handleDisplayNameChange}
        customRepoSelected={customRepoSelected}
        onCustomRepoChange={setCustomRepoSelected}
      />
    </Form>
  );
};
