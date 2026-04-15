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
      await form.validateFields(['name']);
      return extractBoardFormValues(form);
    } catch {
      return null;
    }
  };

  return (
    <Form form={form} layout="vertical" preserve onValuesChange={handleValuesChange}>
      <BoardFormFields form={form} autoFocus />
    </Form>
  );
};
