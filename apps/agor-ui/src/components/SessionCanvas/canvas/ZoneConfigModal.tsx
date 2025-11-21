/**
 * Modal for configuring zone settings (name, triggers, etc.)
 */

import type { BoardObject, ZoneTriggerBehavior } from '@agor/core/types';
import { Alert, Input, Modal, Select, theme } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';

interface ZoneConfigModalProps {
  open: boolean;
  onCancel: () => void;
  zoneName: string;
  objectId: string;
  onUpdate: (objectId: string, objectData: BoardObject) => void;
  zoneData: BoardObject;
}

export const ZoneConfigModal = ({
  open,
  onCancel,
  zoneName,
  objectId,
  onUpdate,
  zoneData,
}: ZoneConfigModalProps) => {
  const { token } = theme.useToken();
  const [name, setName] = useState(zoneName);
  const [triggerBehavior, setTriggerBehavior] = useState<ZoneTriggerBehavior>('show_picker');
  const [triggerTemplate, setTriggerTemplate] = useState('');
  const nameId = useId();
  const triggerBehaviorId = useId();
  const triggerTemplateId = useId();
  const isInitializingRef = useRef(false);

  // Reset form when modal opens (prevent WebSocket updates from erasing user input)
  useEffect(() => {
    if (open && !isInitializingRef.current) {
      isInitializingRef.current = true;
      setName(zoneName);
      // Load existing trigger data if available
      if (zoneData.type === 'zone' && zoneData.trigger) {
        setTriggerBehavior(zoneData.trigger.behavior);
        setTriggerTemplate(zoneData.trigger.template);
      } else {
        setTriggerBehavior('show_picker');
        setTriggerTemplate('');
      }
    } else if (!open) {
      // Reset flag when modal closes
      isInitializingRef.current = false;
    }
  }, [open, zoneName, zoneData]);

  const handleSave = () => {
    if (zoneData.type === 'zone') {
      const hasChanges =
        name !== zoneName ||
        triggerTemplate.trim() !== (zoneData.trigger?.template || '') ||
        triggerBehavior !== (zoneData.trigger?.behavior || 'show_picker');

      if (hasChanges) {
        onUpdate(objectId, {
          ...zoneData,
          label: name,
          // Only save trigger if template is provided
          trigger: triggerTemplate.trim()
            ? {
                behavior: triggerBehavior,
                template: triggerTemplate.trim(),
              }
            : undefined, // Remove trigger if template is empty
        });
      }
    }
    onCancel();
  };

  return (
    <Modal
      title="Configure Zone"
      open={open}
      onCancel={onCancel}
      onOk={handleSave}
      okText="Save"
      cancelText="Cancel"
      width={600}
    >
      {/* Zone Name */}
      <div style={{ marginBottom: 24 }}>
        <label
          htmlFor={nameId}
          style={{
            display: 'block',
            marginBottom: 8,
            fontWeight: 500,
            color: token.colorText,
          }}
        >
          Zone Name
        </label>
        <Input
          id={nameId}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Enter zone name..."
          size="large"
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <label
          htmlFor={triggerBehaviorId}
          style={{
            display: 'block',
            marginBottom: 8,
            fontWeight: 500,
            color: token.colorText,
          }}
        >
          Trigger Behavior
        </label>
        <Select
          id={triggerBehaviorId}
          value={triggerBehavior}
          onChange={setTriggerBehavior}
          style={{ width: '100%' }}
          options={[
            {
              value: 'show_picker',
              label: 'Show Picker - Choose session and action when dropped',
            },
            { value: 'always_new', label: 'Always New - Auto-create new root session' },
          ]}
        />
      </div>

      <div>
        <label
          htmlFor={triggerTemplateId}
          style={{
            display: 'block',
            marginBottom: 8,
            fontWeight: 500,
            color: token.colorText,
          }}
        >
          Trigger Template
        </label>
        <Input.TextArea
          id={triggerTemplateId}
          value={triggerTemplate}
          onChange={e => setTriggerTemplate(e.target.value)}
          placeholder="Enter the prompt template that will be triggered when a worktree is dropped here..."
          rows={6}
        />
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
          style={{ marginTop: 12 }}
        />
      </div>
    </Modal>
  );
};
