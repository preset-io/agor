import { Form, Input, Modal, Switch, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { LinkDisplayItem } from './linkDisplay';
import { canEditLinkTarget, getManualLinkTarget, type ManualLinkDraft } from './linkLifecycle';
import {
  LINK_ACTION_LABEL,
  LINK_FORM_COPY,
  LINK_FORM_FIELD,
  LINK_FORM_LIMIT,
} from './linkUiConstants';

interface LinkEditorValues {
  title?: string;
  target: string;
  isPinned?: boolean;
}

interface LinkEditorModalProps {
  open: boolean;
  item?: LinkDisplayItem | null;
  onCancel: () => void;
  onSubmit: (draft: ManualLinkDraft) => Promise<boolean>;
}

export function LinkEditorModal({ open, item, onCancel, onSubmit }: LinkEditorModalProps) {
  const [form] = Form.useForm<LinkEditorValues>();
  const [saving, setSaving] = useState(false);
  const editing = Boolean(item);
  const targetEditable = !item || canEditLinkTarget(item);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      title: item?.title,
      target: item?.url ?? item?.refUri ?? item?.filePath ?? '',
      isPinned: item?.isPinned ?? false,
    });
  }, [form, item, open]);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const saved = await onSubmit({
        title: values.title,
        target: values.target,
        isPinned: values.isPinned,
      });
      if (saved) {
        form.resetFields();
        onCancel();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing ? LINK_ACTION_LABEL.edit : LINK_ACTION_LABEL.add}
      open={open}
      okText={editing ? LINK_ACTION_LABEL.saveChanges : LINK_ACTION_LABEL.add}
      confirmLoading={saving}
      onOk={() => void handleSubmit()}
      onCancel={onCancel}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item label={LINK_FORM_COPY.label} name={LINK_FORM_FIELD.title}>
          <Input
            placeholder={LINK_FORM_COPY.labelPlaceholder}
            maxLength={LINK_FORM_LIMIT.titleLength}
          />
        </Form.Item>
        <Form.Item
          label={LINK_FORM_COPY.target}
          name={LINK_FORM_FIELD.target}
          extra={
            !targetEditable ? (
              <Typography.Text type="secondary">{LINK_FORM_COPY.targetReadOnly}</Typography.Text>
            ) : undefined
          }
          rules={[
            { required: true, message: LINK_FORM_COPY.targetRequired },
            {
              validator: async (_, value) => {
                if (!value || !targetEditable) return;
                getManualLinkTarget(value);
              },
            },
          ]}
        >
          <Input placeholder={LINK_FORM_COPY.targetPlaceholder} disabled={!targetEditable} />
        </Form.Item>
        {!editing && (
          <Form.Item
            label={LINK_FORM_COPY.pinInContext}
            name={LINK_FORM_FIELD.isPinned}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
