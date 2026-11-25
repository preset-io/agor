import type { Repo } from '@agor-live/client';
import { Form } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { slugify } from '@/utils/repoSlug';
import {
  DEFAULT_TEAMMATE_EMOJI,
  getTeammateTemplate,
  resolveTemplateSourceBranch,
  resolveTemplateSourceRemoteUrl,
  type TeammateGalleryCardId,
} from '@/utils/teammateTemplates';

/**
 * Shared teammate form logic used by CreateDialog's Teammate tab.
 *
 * Encapsulates: form instance, validation, display-name-to-branch-name
 * auto-generation, framework repo auto-select, and custom repo tracking.
 */
export function useTeammateForm(frameworkRepo: Repo | undefined) {
  const [form] = Form.useForm();
  const [isFormValid, setIsFormValid] = useState(false);
  const [customRepoSelected, setCustomRepoSelected] = useState(false);
  const lastAutoName = useRef('');
  const lastAutoEmoji = useRef<string | undefined>(undefined);

  const validateForm = useCallback(() => {
    const values = form.getFieldsValue();
    const hasDisplayName = !!values.displayName?.trim();
    const hasRepo = Boolean(values.repoId || frameworkRepo?.repo_id);
    setIsFormValid(hasDisplayName && hasRepo);
  }, [form, frameworkRepo]);

  // Auto-select framework repo when available. setFieldValue is silent
  // (does not fire onFieldsChange), so re-run validation here — otherwise
  // a name typed while the framework repo was still cloning leaves the
  // submit button stuck disabled after the repo arrives.
  useEffect(() => {
    if (frameworkRepo && !form.getFieldValue('repoId')) {
      form.setFieldValue('repoId', frameworkRepo.repo_id);
    }
    validateForm();
  }, [frameworkRepo, form, validateForm]);

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

  const handleTemplateChange = useCallback(
    (templateId: TeammateGalleryCardId) => {
      const template = getTeammateTemplate(templateId);
      // Like the branch name, a template only fills in the avatar until the
      // user picks their own.
      const currentEmoji = form.getFieldValue('emoji');
      const keepCustomEmoji =
        !!currentEmoji &&
        currentEmoji !== DEFAULT_TEAMMATE_EMOJI &&
        currentEmoji !== lastAutoEmoji.current;
      const templateEmoji = keepCustomEmoji ? undefined : template?.emoji;
      if (templateEmoji) {
        lastAutoEmoji.current = templateEmoji;
      }
      form.setFieldsValue({
        templateId,
        sourceBranch: resolveTemplateSourceBranch(templateId),
        sourceRemoteUrl: resolveTemplateSourceRemoteUrl(templateId),
        ...(templateEmoji ? { emoji: templateEmoji } : {}),
      });
      validateForm();
    },
    [form, validateForm]
  );

  const resetForm = useCallback(() => {
    form.resetFields();
    setIsFormValid(false);
    setCustomRepoSelected(false);
    lastAutoName.current = '';
    lastAutoEmoji.current = undefined;
  }, [form]);

  return {
    form,
    isFormValid,
    setIsFormValid,
    customRepoSelected,
    setCustomRepoSelected,
    validateForm,
    handleDisplayNameChange,
    handleTemplateChange,
    resetForm,
  };
}
