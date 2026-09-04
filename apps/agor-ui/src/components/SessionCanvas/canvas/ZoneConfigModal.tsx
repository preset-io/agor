/**
 * Modal for configuring zone settings (name, triggers, etc.)
 */

import {
  normalizeZoneLayoutPolicy,
  resolveZoneLayoutPolicy,
  zoneLayoutBinding,
} from '@agor/core/layout/zone-layout';
import type {
  AgenticToolName,
  BoardObject,
  ZoneLayoutBinding,
  ZoneLayoutPolicy,
  ZoneTriggerBehavior,
} from '@agor-live/client';
import { isAgenticToolName } from '@agor-live/client';
import { Alert, Divider, Form, Input, Modal, Select, Switch } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useMutationGate } from '../../../contexts/ConnectionContext';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../../AgentSelectionGrid';
import { ExpandableAlert } from '../../ExpandableAlert';
import { ZoneLayoutPolicyEditor } from './ZoneLayoutPolicyEditor';

interface ZoneConfigModalProps {
  open: boolean;
  onCancel: () => void;
  zoneName: string;
  objectId: string;
  onUpdate: (
    objectId: string,
    objectData: BoardObject
  ) => boolean | undefined | Promise<boolean | undefined>;
  zoneData: BoardObject;
  boardZoneLayoutDefaults?: ZoneLayoutPolicy;
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
  boardZoneLayoutDefaults,
}: ZoneConfigModalProps) => {
  const [form] = Form.useForm<ZoneFormValues>();
  const [triggerAgent, setTriggerAgent] = useState<AgenticToolName | null>('claude-code');
  const [layoutPolicy, setLayoutPolicy] = useState<ZoneLayoutPolicy>(() =>
    normalizeZoneLayoutPolicy(undefined)
  );
  const [layoutBinding, setLayoutBinding] = useState<ZoneLayoutBinding>('override');
  const isInitializingRef = useRef(false);
  const mutationGate = useMutationGate();

  const triggerBehavior = Form.useWatch('triggerBehavior', form);

  const zoneTrigger = zoneData.type === 'zone' ? zoneData.trigger : undefined;
  const hasZoneTrigger = Boolean(zoneTrigger);
  const zoneTriggerBehavior = zoneTrigger?.behavior;
  const zoneTriggerTemplate = zoneTrigger?.template;
  const zoneTriggerAgent = zoneTrigger?.agent;
  const requiresSupportedToolSelection = Boolean(
    zoneTriggerAgent && !isAgenticToolName(zoneTriggerAgent) && triggerAgent === null
  );

  // Reset form when modal opens (prevent WebSocket updates from erasing user input).
  // Keep dependencies to stable primitive fields: ZoneNode re-renders often, and
  // passing a freshly-created zone object through this effect used to make AntD's
  // Form/Modal tree re-run initialization work unnecessarily while open.
  useEffect(() => {
    if (open && !isInitializingRef.current) {
      isInitializingRef.current = true;
      const zone = zoneData.type === 'zone' ? zoneData : undefined;
      setLayoutPolicy(
        zone
          ? resolveZoneLayoutPolicy(zone, boardZoneLayoutDefaults)
          : normalizeZoneLayoutPolicy(boardZoneLayoutDefaults)
      );
      setLayoutBinding(zoneLayoutBinding(zone));
      if (hasZoneTrigger) {
        form.setFieldsValue({
          name: zoneName,
          triggerBehavior: zoneTriggerBehavior,
          triggerTemplate: zoneTriggerTemplate,
        });
        setTriggerAgent(
          zoneTriggerAgent === undefined
            ? 'claude-code'
            : isAgenticToolName(zoneTriggerAgent)
              ? zoneTriggerAgent
              : null
        );
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
  }, [
    open,
    zoneName,
    hasZoneTrigger,
    zoneTriggerBehavior,
    zoneTriggerTemplate,
    zoneTriggerAgent,
    zoneData,
    boardZoneLayoutDefaults,
    form,
  ]);

  const handleSave = async () => {
    if (!mutationGate.canMutate) return;
    if (requiresSupportedToolSelection || triggerAgent === null) return;
    try {
      const values = await form.validateFields();

      if (zoneData.type === 'zone') {
        const template = values.triggerTemplate?.trim() || '';
        const layout =
          layoutBinding === 'inherit'
            ? normalizeZoneLayoutPolicy(boardZoneLayoutDefaults)
            : normalizeZoneLayoutPolicy(layoutPolicy);
        const trigger =
          template && values.triggerBehavior
            ? {
                behavior: values.triggerBehavior,
                template,
                agent: triggerAgent,
              }
            : undefined;
        const hasChanges =
          values.name !== zoneName ||
          JSON.stringify(trigger) !== JSON.stringify(zoneData.trigger) ||
          layoutBinding !== zoneLayoutBinding(zoneData) ||
          JSON.stringify(layout) !== JSON.stringify(normalizeZoneLayoutPolicy(zoneData.layout));

        if (hasChanges) {
          const saved = await onUpdate(objectId, {
            ...zoneData,
            label: values.name,
            trigger,
            layout,
            layout_binding: layoutBinding,
          });
          if (saved === false) return;
        }
      }
      onCancel();
    } catch {
      // Validation failed — form will show inline errors
    }
  };

  return (
    <Modal
      title="Configure zone"
      open={open}
      onCancel={onCancel}
      onOk={handleSave}
      okText="Save"
      okButtonProps={{
        disabled: !mutationGate.canMutate || requiresSupportedToolSelection,
      }}
      cancelText="Cancel"
      width={600}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Zone name">
          <Input placeholder="Enter zone name..." size="large" />
        </Form.Item>

        <Divider plain>Layout</Divider>
        <Form.Item
          label="Use board defaults"
          help={
            layoutBinding === 'inherit'
              ? 'This zone follows Zone defaults from Board settings. Turn off to start an independent override from the current values.'
              : 'This zone keeps its own explicit policy. Turn on to reset it to the board defaults and follow future changes.'
          }
        >
          <Switch
            aria-label="Use board defaults"
            checked={layoutBinding === 'inherit'}
            disabled={!mutationGate.canMutate}
            onChange={(checked) => {
              if (checked) setLayoutPolicy(normalizeZoneLayoutPolicy(boardZoneLayoutDefaults));
              setLayoutBinding(checked ? 'inherit' : 'override');
            }}
          />
        </Form.Item>
        <ZoneLayoutPolicyEditor
          value={layoutPolicy}
          onChange={setLayoutPolicy}
          disabled={!mutationGate.canMutate || layoutBinding === 'inherit'}
          idPrefix={`zone-${objectId}`}
        />

        <Divider plain>Automation prompt</Divider>

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

        {requiresSupportedToolSelection && (
          <Alert
            type="warning"
            showIcon
            title="This zone uses a removed agentic tool"
            description="Its saved trigger is preserved, but it cannot create a session. Choose a supported tool to migrate the zone explicitly."
            style={{ marginBottom: 16 }}
          />
        )}

        {(triggerBehavior === 'always_new' || requiresSupportedToolSelection) && (
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
          extra={
            <ExpandableAlert
              // Re-mount when the modal opens or the zone changes so the
              // details collapse back to default; otherwise the AntD Modal
              // keeps children mounted and stale `expanded` state persists.
              key={`${objectId}:${open}`}
              title="Handlebars template support"
              summary="Reference branch, session, and board data with {{ ... }} syntax."
            >
              <p style={{ marginBottom: 8 }}>
                Use Handlebars syntax to reference session and board data in your trigger:
              </p>
              <ul style={{ marginLeft: 16, marginBottom: 8 }}>
                <li>
                  <code>{'{{ branch.issue_url }}'}</code> - GitHub issue URL
                </li>
                <li>
                  <code>{'{{ branch.pull_request_url }}'}</code> - Pull request URL
                </li>
                <li>
                  <code>{'{{ branch.notes }}'}</code> - Branch notes
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
                    'Review {{ branch.issue_url }} for {{ board.context.team }} sprint {{ board.context.sprint }}'
                  }
                </code>
              </p>
            </ExpandableAlert>
          }
        >
          <Input.TextArea
            placeholder="Enter the prompt template that will be triggered when a branch is dropped here..."
            rows={6}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
