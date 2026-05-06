/**
 * Modal for configuring zone settings (name, triggers, etc.)
 */

import type { AgenticToolName, BoardObject, ZoneTriggerBehavior } from '@agor-live/client';
import { Alert, Form, Input, Modal, Select } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useMutationGate } from '../../../contexts/ConnectionContext';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../../AgentSelectionGrid';

interface ZoneConfigModalProps {
  open: boolean;
  onCancel: () => void;
  zoneName: string;
  objectId: string;
  onUpdate: (objectId: string, objectData: BoardObject) => void;
  zoneData: BoardObject;
}

interface ZoneFormValues {
  name: string;
  triggerBehavior: ZoneTriggerBehavior;
  triggerTemplate: string;
}

// Sensible default so that a freshly-created zone always has a behavior
// selected — previously the field came up blank, the Select allowed clearing,
// and any template the user typed got silently discarded on save unless they
// also remembered to pick a behavior. With a default of 'show_picker', the
// template is preserved by default and users only need to opt OUT (by leaving
// the template empty) for an organizational-only zone.
const DEFAULT_TRIGGER_BEHAVIOR: ZoneTriggerBehavior = 'show_picker';

export const ZoneConfigModal = ({
  open,
  onCancel,
  zoneName,
  objectId,
  onUpdate,
  zoneData,
}: ZoneConfigModalProps) => {
  const [form] = Form.useForm<ZoneFormValues>();
  const [triggerAgent, setTriggerAgent] = useState<AgenticToolName>('claude-code');
  const isInitializingRef = useRef(false);
  const mutationGate = useMutationGate();

  const triggerBehavior = Form.useWatch('triggerBehavior', form);

  // Reset form when modal opens (prevent WebSocket updates from erasing user input)
  useEffect(() => {
    if (open && !isInitializingRef.current) {
      isInitializingRef.current = true;
      if (zoneData.type === 'zone' && zoneData.trigger) {
        form.setFieldsValue({
          name: zoneName,
          triggerBehavior: zoneData.trigger.behavior,
          triggerTemplate: zoneData.trigger.template,
        });
        setTriggerAgent(zoneData.trigger.agent || 'claude-code');
      } else {
        form.setFieldsValue({
          name: zoneName,
          triggerBehavior: DEFAULT_TRIGGER_BEHAVIOR,
          triggerTemplate: '',
        });
        setTriggerAgent('claude-code');
      }
    } else if (!open) {
      isInitializingRef.current = false;
    }
  }, [open, zoneName, zoneData, form]);

  const handleSave = async () => {
    if (!mutationGate.canMutate) return;
    try {
      const values = await form.validateFields();

      if (zoneData.type === 'zone') {
        const template = values.triggerTemplate?.trim() || '';
        const hasChanges =
          values.name !== zoneName ||
          template !== (zoneData.trigger?.template || '') ||
          values.triggerBehavior !== (zoneData.trigger?.behavior || undefined) ||
          triggerAgent !== (zoneData.trigger?.agent || 'claude-code');

        if (hasChanges) {
          onUpdate(objectId, {
            ...zoneData,
            label: values.name,
            trigger:
              template && values.triggerBehavior
                ? {
                    behavior: values.triggerBehavior,
                    template,
                    agent: triggerAgent,
                  }
                : undefined,
          });
        }
      }
      onCancel();
    } catch {
      // Validation failed — form will show inline errors
    }
  };

  return (
    <Modal
      title="Configure Zone"
      open={open}
      onCancel={onCancel}
      onOk={handleSave}
      okText="Save"
      okButtonProps={{
        disabled: !mutationGate.canMutate,
      }}
      cancelText="Cancel"
      width={600}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Zone Name">
          <Input placeholder="Enter zone name..." size="large" />
        </Form.Item>

        <Form.Item name="triggerBehavior" label="Trigger Behavior">
          {/* No allowClear / no placeholder: the field always has a value
              (DEFAULT_TRIGGER_BEHAVIOR for new zones), so there is no
              "unset" state to represent. To make a zone organizational
              only, leave the template empty. */}
          <Select
            style={{ width: '100%' }}
            options={[
              {
                value: 'show_picker',
                label: 'Show Picker - Choose session and action when dropped',
              },
              { value: 'always_new', label: 'Always New - Auto-create new root session' },
            ]}
          />
        </Form.Item>

        {triggerBehavior === 'always_new' && (
          <Form.Item
            label="Agent"
            help="New sessions will use the dropping user's default configuration for this agent."
          >
            <AgentSelectionGrid
              agents={AVAILABLE_AGENTS}
              selectedAgentId={triggerAgent}
              onSelect={(id) => setTriggerAgent(id as AgenticToolName)}
              columns={2}
              showHelperText={false}
              showComparisonLink={false}
            />
          </Form.Item>
        )}

        <Form.Item
          name="triggerTemplate"
          label="Trigger Template"
          help="Leave empty for an organizational-only zone (no trigger fires on drop)."
        >
          <Input.TextArea
            placeholder="Enter the prompt template that will be triggered when a worktree is dropped here..."
            rows={6}
          />
        </Form.Item>

        <Alert
          message="Handlebars Template Support"
          description={
            <div>
              <p style={{ marginBottom: 8 }}>
                Use Handlebars syntax to reference session and board data in your trigger:
              </p>
              <ul style={{ marginLeft: 16, marginBottom: 8 }}>
                <li>
                  <code>{'{{ worktree.issue_url }}'}</code> - GitHub issue URL
                </li>
                <li>
                  <code>{'{{ worktree.pull_request_url }}'}</code> - Pull request URL
                </li>
                <li>
                  <code>{'{{ worktree.notes }}'}</code> - Worktree notes
                </li>
                <li>
                  <code>{'{{ session.description }}'}</code> - Session description
                </li>
                <li>
                  <code>{'{{ session.context.* }}'}</code> - Custom context from session settings
                </li>
                <li>
                  <code>{'{{ board.name }}'}</code> - Board name
                </li>
                <li>
                  <code>{'{{ board.description }}'}</code> - Board description
                </li>
                <li>
                  <code>{'{{ board.context.* }}'}</code> - Custom context from board settings
                </li>
              </ul>
              <p style={{ marginTop: 8, marginBottom: 0 }}>
                Example:{' '}
                <code>
                  {
                    'Review {{ worktree.issue_url }} for {{ board.context.team }} sprint {{ board.context.sprint }}'
                  }
                </code>
              </p>
            </div>
          }
          type="info"
          showIcon
          style={{ marginTop: 0 }}
        />
      </Form>
    </Modal>
  );
};
