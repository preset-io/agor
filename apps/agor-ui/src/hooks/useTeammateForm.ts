import { Form } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { slugify } from '@/utils/repoSlug';

/**
 * Shared teammate form logic used by CreateDialog's Teammate tab.
 *
 * Encapsulates: form instance, validation, display-name-to-branch-name
 * auto-generation and explicit destination validation.
 */
export function useTeammateForm() {
  const [form] = Form.useForm();
  const [isFormValid, setIsFormValid] = useState(false);
  const lastAutoName = useRef('');

  const validateForm = useCallback(() => {
    const values = form.getFieldsValue();
    const hasDisplayName = !!values.displayName?.trim();
    const hasRepo = Boolean(values.repoId);
    setIsFormValid(hasDisplayName && hasRepo);
  }, [form]);

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
    lastAutoName.current = '';
  }, [form]);

  return {
    form,
    isFormValid,
    setIsFormValid,
    validateForm,
    handleDisplayNameChange,
    resetForm,
  };
}
