import type { CreateLocalRepoRequest, CreateRepoRequest } from '@agor-live/client';
import type { RadioChangeEvent } from 'antd';
import { Form } from 'antd';
import { useCallback, useState } from 'react';
import { RepoFormFields } from '../../forms/RepoFormFields';

export interface RepoTabResult {
  mode: 'remote' | 'local';
  remote?: CreateRepoRequest;
  local?: CreateLocalRepoRequest;
}

export interface RepoTabProps {
  onValidityChange: (valid: boolean) => void;
  formRef: React.MutableRefObject<(() => Promise<RepoTabResult | null>) | null>;
}

export const RepoTab: React.FC<RepoTabProps> = ({ onValidityChange, formRef }) => {
  const [form] = Form.useForm();
  const [repoMode, setRepoMode] = useState<'remote' | 'local'>('remote');

  const handleValuesChange = useCallback(() => {
    setTimeout(() => {
      const values = form.getFieldsValue();
      if (repoMode === 'local') {
        onValidityChange(!!values.path?.trim());
      } else {
        onValidityChange(!!(values.url?.trim() && values.slug?.trim()));
      }
    }, 0);
  }, [form, onValidityChange, repoMode]);

  const handleModeChange = (e: RadioChangeEvent) => {
    const value = e.target.value as 'remote' | 'local';
    setRepoMode(value);
    form.resetFields();
    form.setFieldsValue({
      default_branch: value === 'remote' ? 'main' : undefined,
    });
    onValidityChange(false);
  };

  formRef.current = async () => {
    try {
      const values = await form.validateFields();
      if (repoMode === 'local') {
        return {
          mode: 'local',
          local: { path: values.path, slug: values.slug || undefined },
        };
      }
      return {
        mode: 'remote',
        remote: {
          url: values.url,
          slug: values.slug,
          default_branch: values.default_branch || 'main',
        },
      };
    } catch {
      return null;
    }
  };

  return (
    <Form
      form={form}
      layout="vertical"
      onValuesChange={handleValuesChange}
      initialValues={{ default_branch: 'main' }}
    >
      <RepoFormFields
        form={form}
        mode="create"
        repoMode={repoMode}
        onRepoModeChange={handleModeChange}
      />
    </Form>
  );
};
