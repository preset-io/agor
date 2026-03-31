import type { Board, Repo } from '@agor/core/types';
import { Form } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { slugify } from '@/utils/repoSlug';
import { AssistantFormFields, CREATE_NEW_BOARD } from '../../forms/AssistantFormFields';

const FRAMEWORK_REPO_SLUG = 'preset-io/agor-assistant';

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
        onDisplayNameChange={handleDisplayNameChange}
        customRepoSelected={customRepoSelected}
        onCustomRepoChange={setCustomRepoSelected}
      />
    </Form>
  );
};
