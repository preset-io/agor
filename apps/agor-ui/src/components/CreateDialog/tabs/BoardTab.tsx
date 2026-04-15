import type { Board } from '@agor-live/client';
import { Form } from 'antd';
import { useCallback, useState } from 'react';
import { BoardFormFields } from '../../forms/BoardFormFields';

export interface BoardTabProps {
  onValidityChange: (valid: boolean) => void;
  formRef: React.MutableRefObject<(() => Promise<Partial<Board> | null>) | null>;
}

export const BoardTab: React.FC<BoardTabProps> = ({ onValidityChange, formRef }) => {
  const [form] = Form.useForm();
  const [useCustomCSS, setUseCustomCSS] = useState(false);

  const handleValuesChange = useCallback(() => {
    setTimeout(() => {
      const values = form.getFieldsValue();
      onValidityChange(!!values.name?.trim());
    }, 0);
  }, [form, onValidityChange]);

  formRef.current = async () => {
    try {
      const values = await form.validateFields();
      return {
        name: values.name,
        icon: values.icon || '📋',
        description: values.description,
        background_color: values.background_color
          ? typeof values.background_color === 'string'
            ? values.background_color
            : values.background_color.toHexString()
          : undefined,
        custom_css: values.custom_css || undefined,
      };
    } catch {
      return null;
    }
  };

  return (
    <Form form={form} layout="vertical" onValuesChange={handleValuesChange}>
      <BoardFormFields
        form={form}
        useCustomCSS={useCustomCSS}
        onCustomCSSChange={setUseCustomCSS}
        autoFocus
      />
    </Form>
  );
};
