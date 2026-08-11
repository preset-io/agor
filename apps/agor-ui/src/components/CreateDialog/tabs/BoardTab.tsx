import type { Board } from '@agor-live/client';
import { Form } from 'antd';
import { useCallback } from 'react';
import { BoardFormFields, extractBoardFormValues } from '../../forms/BoardFormFields';

export interface BoardTabProps {
  onValidityChange: (valid: boolean) => void;
  formRef: React.MutableRefObject<(() => Promise<Partial<Board> | null>) | null>;
}

export const BoardTab: React.FC<BoardTabProps> = ({ onValidityChange, formRef }) => {
  const [form] = Form.useForm();

  const handleValuesChange = useCallback(() => {
    setTimeout(() => {
      const values = form.getFieldsValue();
      onValidityChange(!!values.name?.trim());
    }, 0);
  }, [form, onValidityChange]);

  formRef.current = async () => {
    try {
      // Validate all fields (not just 'name') so custom_context JSON rules run
      // before the extractor calls JSON.parse on it.
      await form.validateFields();
      return extractBoardFormValues(form);
    } catch {
      // Antd displays inline field errors; parent treats null as "not valid".
      return null;
    }
  };

  return (
    <Form form={form} layout="vertical" preserve onValuesChange={handleValuesChange}>
      <BoardFormFields form={form} autoFocus />
    </Form>
  );
};
