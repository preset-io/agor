import type { AgenticToolPreset, AgorClient, TenantAgenticToolName } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Empty, Form, Input, List, Popconfirm, Space, Switch, Tag, Typography } from 'antd';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  type AuthorityOperation,
  useAuthorityOperationGuard,
} from '../../hooks/useAuthorityOperationGuard';
import {
  AgenticToolConfigForm,
  buildConfigFromFormValues,
  getFormValuesFromConfig,
} from '../AgenticToolConfigForm';

import { AdaptiveSettingsModal } from './AdaptiveSettingsModal';

interface Props {
  client: AgorClient;
  tool: TenantAgenticToolName;
  onError(message: string): void;
  identityKey: string | null;
  operationScope: readonly unknown[] | null;
}

export const AgenticToolPresetsManager: React.FC<Props> = ({
  client,
  tool,
  onError,
  identityKey,
  operationScope,
}) => {
  const [form] = Form.useForm();
  const [presets, setPresets] = useState<AgenticToolPreset[]>([]);
  const [editing, setEditing] = useState<AgenticToolPreset | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const operationGuard = useAuthorityOperationGuard(operationScope);

  // biome-ignore lint/correctness/useExhaustiveDependencies: identityKey intentionally erases the replacement caller's modal/form state
  useLayoutEffect(() => {
    form.resetFields();
    setPresets([]);
    setEditing(null);
    setModalOpen(false);
    setSaving(false);
  }, [form, identityKey]);

  // A same-user reconnect/auth-generation change cancels the old save. Keep
  // their open form and draft, but release the generation-owned spinner even
  // though the stale promise's finally block is correctly forbidden to write.
  // biome-ignore lint/correctness/useExhaustiveDependencies: operationGuard identity is the semantic authority-epoch key
  useLayoutEffect(() => {
    setSaving(false);
  }, [operationGuard]);

  const load = useCallback(
    async (parentOperation?: AuthorityOperation) => {
      const operation = parentOperation ?? operationGuard.begin();
      if (!operation.isCurrent()) return;
      try {
        const result = await client.service('agentic-tool-presets').find({ query: { tool } });
        if (!operation.isCurrent()) return;
        setPresets(Array.isArray(result) ? result : result.data);
      } catch (error) {
        if (!operation.isCurrent()) return;
        onError(error instanceof Error ? error.message : 'Failed to load presets');
      }
    },
    [client, onError, operationGuard, tool]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const open = (preset?: AgenticToolPreset) => {
    if (!operationGuard.isCurrent()) return;
    setEditing(preset ?? null);
    form.setFieldsValue({
      name: preset?.name,
      description: preset?.description,
      is_default: preset?.is_default ?? false,
      ...getFormValuesFromConfig(tool, preset?.configuration),
    });
    setModalOpen(true);
  };

  const save = async () => {
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
    try {
      const values = await form.validateFields();
      if (!operation.isCurrent()) return;
      setSaving(true);
      const data = {
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        is_default: values.is_default ?? false,
        configuration: buildConfigFromFormValues(tool, values),
      };
      if (editing) await client.service('agentic-tool-presets').patch(editing.preset_id, data);
      else await client.service('agentic-tool-presets').create({ ...data, tool });
      if (!operation.isCurrent()) return;
      setModalOpen(false);
      await load(operation);
    } catch (error) {
      if (!operation.isCurrent()) return;
      onError(error instanceof Error ? error.message : 'Failed to save preset');
    } finally {
      if (operation.isCurrent()) setSaving(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <div>
          <Typography.Text strong>Presets</Typography.Text>
          <br />
          <Typography.Text type="secondary">
            Live administrator-managed configurations for {tool}.
          </Typography.Text>
        </div>
        <Button icon={<PlusOutlined />} onClick={() => open()}>
          New preset
        </Button>
      </Space>
      {presets.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No presets" />
      ) : (
        <List
          bordered
          dataSource={presets}
          renderItem={(preset) => (
            <List.Item
              actions={[
                <Button
                  key="edit"
                  type="text"
                  icon={<EditOutlined />}
                  onClick={() => open(preset)}
                />,
                <Popconfirm
                  key="delete"
                  title="Delete this preset?"
                  description="Referenced presets cannot be deleted."
                  onConfirm={async () => {
                    const operation = operationGuard.begin();
                    if (!operation.isCurrent()) return;
                    try {
                      await client.service('agentic-tool-presets').remove(preset.preset_id);
                      if (!operation.isCurrent()) return;
                      await load(operation);
                    } catch (error) {
                      if (!operation.isCurrent()) return;
                      onError(error instanceof Error ? error.message : 'Failed to delete preset');
                    }
                  }}
                >
                  <Button type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    {preset.name}
                    {preset.is_default && <Tag color="blue">Default</Tag>}
                  </Space>
                }
                description={preset.description}
              />
            </List.Item>
          )}
        />
      )}
      <AdaptiveSettingsModal
        title={editing ? `Edit ${editing.name}` : `New ${tool} preset`}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void save()}
        confirmLoading={saving}
        destroyOnHidden
        width={680}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item
            name="is_default"
            label="Default for new configurations"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <AgenticToolConfigForm agenticTool={tool} client={client} />
        </Form>
      </AdaptiveSettingsModal>
    </Space>
  );
};
