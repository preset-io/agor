import type { Repo } from '@agor-live/client';
import { Form } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { slugify } from '@/utils/repoSlug';

/**
 * Shared assistant form logic used by both CreateDialog's AssistantTab
 * and SettingsModal's AssistantsTable create modal.
 *
 * Encapsulates: form instance, validation, display-name-to-worktree-name
 * auto-generation, framework repo auto-select, and custom repo tracking.
 */
export function useAssistantForm(frameworkRepo: Repo | undefined) {
  const [form] = Form.useForm();
  const [isFormValid, setIsFormValid] = useState(false);
  const [customRepoSelected, setCustomRepoSelected] = useState(false);
  const lastAutoName = useRef('');

  // Auto-select framework repo when available
  useEffect(() => {
    if (frameworkRepo && !form.getFieldValue('repoId')) {
      form.setFieldValue('repoId', frameworkRepo.repo_id);
    }
  }, [frameworkRepo, form]);

  const validateForm = useCallback(() => {
    const values = form.getFieldsValue();
    const hasDisplayName = !!values.displayName?.trim();
    const hasRepo = Boolean(values.repoId || frameworkRepo?.repo_id);
    setIsFormValid(hasDisplayName && hasRepo);
  }, [form, frameworkRepo]);

  const handleDisplayNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const displayName = e.target.value;
      const currentName = form.getFieldValue('name');
      const autoName = `private-${slugify(displayName)}`;
      if (!currentName || currentName === lastAutoName.current) {
        form.setFieldValue('name', autoName);
        lastAutoName.current = autoName;
      }
      validateForm();
    },
    [form, validateForm]
  );

  const resetForm = useCallback(() => {
    form.resetFields();
    setIsFormValid(false);
    setCustomRepoSelected(false);
    lastAutoName.current = '';
  }, [form]);

  return {
    form,
    isFormValid,
    setIsFormValid,
    customRepoSelected,
    setCustomRepoSelected,
    validateForm,
    handleDisplayNameChange,
    resetForm,
  };
}
