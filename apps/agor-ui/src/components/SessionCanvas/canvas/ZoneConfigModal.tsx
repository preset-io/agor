/**
 * Modal for configuring zone identity, appearance, placement, and automation.
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
import {
  Alert,
  Button,
  ColorPicker,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Tabs,
  Typography,
  theme,
} from 'antd';
import type { Color } from 'antd/es/color-picker';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutationGate } from '../../../contexts/ConnectionContext';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../../AgentSelectionGrid';
import { ExpandableAlert } from '../../ExpandableAlert';
import { ZoneLayoutPolicyEditor } from './ZoneLayoutPolicyEditor';
import { toTranslucentZoneFill, ZONE_CONTENT_OPACITY } from './zoneAppearance';
import {
  sanitizeZoneFontSize,
  ZONE_FONT_SIZE_MAX,
  ZONE_FONT_SIZE_MIN,
  ZONE_FONT_SIZE_STEP,
} from './zoneFontSize';

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
  canEdit?: boolean;
}

interface ZoneFormValues {
  name: string;
  locked: boolean;
  triggerBehavior: ZoneTriggerBehavior;
  triggerTemplate: string;
}

// A newly configured trigger defaults to the picker. An empty template still
// means an organizational-only zone and persists no trigger.
const DEFAULT_TRIGGER_BEHAVIOR: ZoneTriggerBehavior = 'show_picker';

export const ZoneConfigModal = ({
  open,
  onCancel,
  zoneName,
  objectId,
  onUpdate,
  zoneData,
  boardZoneLayoutDefaults,
  canEdit = true,
}: ZoneConfigModalProps) => {
  const { token } = theme.useToken();
  const [form] = Form.useForm<ZoneFormValues>();
  const [triggerAgent, setTriggerAgent] = useState<AgenticToolName | null>('claude-code');
  const [borderColor, setBorderColor] = useState<string | undefined>();
  const [backgroundColor, setBackgroundColor] = useState<string | undefined>();
  const [fontSize, setFontSize] = useState<number | undefined>();
  const [clearLegacyColor, setClearLegacyColor] = useState(false);
  const [layoutPolicy, setLayoutPolicy] = useState<ZoneLayoutPolicy>(() =>
    normalizeZoneLayoutPolicy(undefined)
  );
  const [layoutBinding, setLayoutBinding] = useState<ZoneLayoutBinding>('override');
  const isInitializingRef = useRef(false);
  const mutationGate = useMutationGate();

  const triggerBehavior = Form.useWatch('triggerBehavior', form);
  const triggerTemplate = Form.useWatch('triggerTemplate', form);
  const automationActive = Boolean(triggerTemplate?.trim());
  const zone = zoneData.type === 'zone' ? zoneData : undefined;
  const isZone = zone !== undefined;
  const zoneTrigger = zone?.trigger;
  const hasZoneTrigger = Boolean(zoneTrigger);
  const zoneTriggerBehavior = zoneTrigger?.behavior;
  const zoneTriggerTemplate = zoneTrigger?.template;
  const zoneTriggerAgent = zoneTrigger?.agent;
  const savedLayout = zone?.layout;
  const savedLayoutBinding = zone?.layout_binding;
  const requiresSupportedToolSelection = Boolean(
    zoneTriggerAgent && !isAgenticToolName(zoneTriggerAgent) && triggerAgent === null
  );

  const palette = useMemo(
    () => [
      token.colorBorder,
      token.red6 || token.red,
      token.orange6 || token.orange,
      token.green6 || token.green,
      token.blue6 || token.blue,
      token.purple6 || token.purple,
      token.magenta6 || token.magenta,
    ],
    [token]
  );

  const legacyColor = clearLegacyColor ? undefined : zone?.color;
  const effectiveBorderColor = borderColor ?? legacyColor ?? token.colorBorder;
  const effectiveBackgroundColor =
    backgroundColor ??
    (borderColor
      ? borderColor
      : legacyColor
        ? toTranslucentZoneFill(legacyColor, `${token.colorBgContainer}40`)
        : `${token.colorBgContainer}40`);

  // Reset only when the modal opens. Live board patches must not erase edits in
  // progress, but reopening should always reflect the freshest zone object.
  useEffect(() => {
    if (open && !isInitializingRef.current) {
      isInitializingRef.current = true;
      form.setFieldsValue({
        name: zoneName,
        locked: Boolean(zone?.locked),
        triggerBehavior: hasZoneTrigger ? zoneTriggerBehavior : DEFAULT_TRIGGER_BEHAVIOR,
        triggerTemplate: hasZoneTrigger ? zoneTriggerTemplate : '',
      });
      setBorderColor(zone?.borderColor);
      setBackgroundColor(zone?.backgroundColor);
      setFontSize(sanitizeZoneFontSize(zone?.fontSize));
      setClearLegacyColor(false);
      setLayoutPolicy(
        isZone
          ? resolveZoneLayoutPolicy(
              { layout: savedLayout, layout_binding: savedLayoutBinding },
              boardZoneLayoutDefaults
            )
          : normalizeZoneLayoutPolicy(boardZoneLayoutDefaults)
      );
      setLayoutBinding(zoneLayoutBinding({ layout_binding: savedLayoutBinding }));
      setTriggerAgent(
        hasZoneTrigger
          ? zoneTriggerAgent === undefined
            ? 'claude-code'
            : isAgenticToolName(zoneTriggerAgent)
              ? zoneTriggerAgent
              : null
          : 'claude-code'
      );
    } else if (!open) {
      isInitializingRef.current = false;
    }
  }, [
    open,
    zoneName,
    zone?.locked,
    zone?.borderColor,
    zone?.backgroundColor,
    zone?.fontSize,
    hasZoneTrigger,
    zoneTriggerBehavior,
    zoneTriggerTemplate,
    zoneTriggerAgent,
    savedLayout,
    savedLayoutBinding,
    isZone,
    boardZoneLayoutDefaults,
    form,
  ]);

  const handleBorderColorChange = (color: Color) => {
    // Introducing borderColor changes the renderer's fallback semantics. Keep
    // the legacy `color` fill translucent by materializing it before saving.
    if (
      zone?.color &&
      !zone.borderColor &&
      !zone.backgroundColor &&
      backgroundColor === undefined
    ) {
      setBackgroundColor(toTranslucentZoneFill(zone.color, `${token.colorBgContainer}40`));
    }
    setBorderColor(color.toHexString());
  };
  const handleBackgroundColorChange = (color: Color) => setBackgroundColor(color.toHexString());

  const handleSave = async () => {
    if (
      !mutationGate.canMutate ||
      !canEdit ||
      requiresSupportedToolSelection ||
      triggerAgent === null
    )
      return;
    try {
      const values = await form.validateFields();
      if (!zone) {
        onCancel();
        return;
      }

      // Ant only returns fields registered by a mounted tab. A user can open
      // Zone settings and save from Layout without ever mounting Appearance,
      // so preserve identity/placement values that were not part of this
      // submission instead of serializing them as undefined/false.
      const nextName = values.name ?? zoneName;
      const nextLocked = values.locked ?? Boolean(zone.locked);
      const template = values.triggerTemplate?.trim() || '';
      const nextTrigger =
        template && values.triggerBehavior
          ? { behavior: values.triggerBehavior, template, agent: triggerAgent }
          : undefined;
      const layout =
        layoutBinding === 'inherit'
          ? normalizeZoneLayoutPolicy(boardZoneLayoutDefaults)
          : normalizeZoneLayoutPolicy(layoutPolicy);
      const hasChanges =
        nextName !== zoneName ||
        Boolean(nextLocked) !== Boolean(zone.locked) ||
        borderColor !== zone.borderColor ||
        backgroundColor !== zone.backgroundColor ||
        fontSize !== sanitizeZoneFontSize(zone.fontSize) ||
        (clearLegacyColor && zone.color !== undefined) ||
        JSON.stringify(nextTrigger) !== JSON.stringify(zone.trigger) ||
        layoutBinding !== zoneLayoutBinding(zone) ||
        JSON.stringify(layout) !== JSON.stringify(normalizeZoneLayoutPolicy(zone.layout));

      if (hasChanges) {
        const saved = await onUpdate(objectId, {
          ...zone,
          label: nextName,
          locked: Boolean(nextLocked),
          borderColor,
          backgroundColor,
          fontSize,
          color: clearLegacyColor ? undefined : zone.color,
          trigger: nextTrigger,
          layout,
          layout_binding: layoutBinding,
        });
        if (saved === false) return;
      }
      onCancel();
    } catch {
      // Validation or persistence failed. Validation renders inline feedback;
      // persistence keeps the modal open so the operator can retry.
    }
  };

  const generalContent = (
    <>
      <Form.Item name="name" label="Name">
        <Input placeholder="Enter zone name..." autoComplete="off" />
      </Form.Item>

      <Typography.Title level={5}>Appearance</Typography.Title>
      <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
        <Flex justify="space-between" align="center" gap="middle" wrap>
          <div>
            <Typography.Text>Border color</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              The zone outline and resize handles.
            </Typography.Text>
          </div>
          <Space>
            <ColorPicker
              value={effectiveBorderColor}
              onChange={handleBorderColorChange}
              showText
              format="hex"
              presets={[{ label: 'Presets', colors: palette }]}
            >
              <Button aria-label="Zone border color">{effectiveBorderColor.toUpperCase()}</Button>
            </ColorPicker>
            <Button
              size="small"
              disabled={borderColor === undefined && legacyColor === undefined}
              onClick={() => {
                if (legacyColor && backgroundColor === undefined) {
                  setBackgroundColor(
                    toTranslucentZoneFill(legacyColor, `${token.colorBgContainer}40`)
                  );
                }
                setBorderColor(undefined);
                setClearLegacyColor(true);
              }}
            >
              Use default
            </Button>
          </Space>
        </Flex>

        <Flex justify="space-between" align="center" gap="middle" wrap>
          <div>
            <Typography.Text>Fill color</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              Supports transparency so cards remain readable.
            </Typography.Text>
          </div>
          <Space>
            <ColorPicker
              value={effectiveBackgroundColor}
              onChange={handleBackgroundColorChange}
              showText
              format="hex"
              presets={[
                {
                  label: 'Presets',
                  colors: palette.map(
                    (color) =>
                      `${color}${Math.round(ZONE_CONTENT_OPACITY * 255)
                        .toString(16)
                        .padStart(2, '0')}`
                  ),
                },
              ]}
            >
              <Button aria-label="Zone fill color">{effectiveBackgroundColor.toUpperCase()}</Button>
            </ColorPicker>
            <Button
              size="small"
              disabled={backgroundColor === undefined && legacyColor === undefined}
              onClick={() => {
                if (legacyColor && borderColor === undefined) setBorderColor(legacyColor);
                setBackgroundColor(undefined);
                setClearLegacyColor(true);
              }}
            >
              Use default
            </Button>
          </Space>
        </Flex>

        <Flex justify="space-between" align="center" gap="middle" wrap>
          <div>
            <Typography.Text>Label size</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              Uses the theme default when no custom size is set.
            </Typography.Text>
          </div>
          <Space.Compact>
            <InputNumber
              aria-label="Zone label size"
              min={ZONE_FONT_SIZE_MIN}
              max={ZONE_FONT_SIZE_MAX}
              step={ZONE_FONT_SIZE_STEP}
              value={fontSize ?? token.fontSize}
              onChange={(value) => setFontSize(sanitizeZoneFontSize(value))}
              style={{ width: 112 }}
            />
            <Button disabled={fontSize === undefined} onClick={() => setFontSize(undefined)}>
              Use default
            </Button>
          </Space.Compact>
        </Flex>
      </Space>

      <Typography.Title level={5} style={{ marginTop: token.marginLG }}>
        Placement
      </Typography.Title>
      <Form.Item
        name="locked"
        label="Lock position and size"
        valuePropName="checked"
        extra="Prevents accidental moving and resizing. Other zone settings remain editable."
      >
        <Switch />
      </Form.Item>
    </>
  );

  const automationContent = (
    <>
      <Typography.Paragraph>
        Configure the prompt that runs when a branch enters this zone and how Agor starts it.
      </Typography.Paragraph>

      <Alert
        type={automationActive ? 'success' : 'info'}
        showIcon
        title={automationActive ? 'Automation active' : 'No prompt configured'}
        description={
          automationActive
            ? 'Dropping a branch into this zone will use the prompt below.'
            : 'This zone is organizational only until you add a prompt.'
        }
        style={{ marginBottom: token.margin }}
      />

      {requiresSupportedToolSelection && (
        <Alert
          type="warning"
          showIcon
          title="This zone uses a removed agentic tool"
          description="Its saved trigger is preserved, but it cannot create a session. Choose a supported tool to migrate the zone explicitly."
          style={{ marginBottom: token.margin }}
        />
      )}

      <Form.Item
        name="triggerTemplate"
        label="Prompt template"
        help="Leave empty to keep this as an organizational-only zone."
        extra={
          <ExpandableAlert
            key={`${objectId}:${open}`}
            title="Handlebars template support"
            summary="Reference branch, session, and board data with {{ ... }} syntax."
          >
            <p style={{ marginBottom: token.marginXS }}>
              Use Handlebars syntax to reference session and board data in your trigger:
            </p>
            <ul style={{ marginLeft: token.margin, marginBottom: token.marginXS }}>
              <li>
                <code>{'{{ branch.issue_url }}'}</code> — GitHub issue URL
              </li>
              <li>
                <code>{'{{ branch.pull_request_url }}'}</code> — Pull request URL
              </li>
              <li>
                <code>{'{{ branch.notes }}'}</code> — Branch notes
              </li>
              <li>
                <code>{'{{ session.description }}'}</code> — Session description
              </li>
              <li>
                <code>{'{{ session.context.* }}'}</code> — Custom session context
              </li>
              <li>
                <code>{'{{ board.name }}'}</code> — Board name
              </li>
              <li>
                <code>{'{{ board.description }}'}</code> — Board description
              </li>
              <li>
                <code>{'{{ board.context.* }}'}</code> — Custom board context
              </li>
            </ul>
            <p style={{ marginTop: token.marginXS, marginBottom: 0 }}>
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
          placeholder="Enter the prompt template that runs when a branch is dropped here..."
          rows={6}
        />
      </Form.Item>

      <Form.Item name="triggerBehavior" label="When a branch enters this zone">
        <Select
          aria-label="Trigger behavior"
          style={{ width: '100%' }}
          options={[
            {
              value: 'show_picker',
              label: 'Show picker — choose session and action when dropped',
            },
            { value: 'always_new', label: 'Always new — auto-create a new root session' },
          ]}
        />
      </Form.Item>

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
    </>
  );

  const layoutContent = (
    <>
      <Typography.Paragraph>
        Choose how this zone packs its contents. Geometry and content expansion are independent.
      </Typography.Paragraph>
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
          disabled={!mutationGate.canMutate || !canEdit}
          onChange={(checked) => {
            if (checked) setLayoutPolicy(normalizeZoneLayoutPolicy(boardZoneLayoutDefaults));
            setLayoutBinding(checked ? 'inherit' : 'override');
          }}
        />
      </Form.Item>
      <ZoneLayoutPolicyEditor
        value={layoutPolicy}
        onChange={setLayoutPolicy}
        disabled={!mutationGate.canMutate || !canEdit || layoutBinding === 'inherit'}
        idPrefix={`zone-${objectId}`}
      />
    </>
  );

  return (
    <Modal
      title="Zone settings"
      open={open}
      onCancel={onCancel}
      onOk={handleSave}
      okText="Save"
      okButtonProps={{
        disabled: !mutationGate.canMutate || !canEdit || requiresSupportedToolSelection,
      }}
      cancelText="Cancel"
      width={640}
    >
      <Form form={form} layout="vertical">
        <Tabs
          defaultActiveKey="automation"
          items={[
            {
              key: 'automation',
              label: requiresSupportedToolSelection ? 'Automation (action required)' : 'Automation',
              children: automationContent,
            },
            {
              key: 'appearance',
              label: 'Appearance & placement',
              children: generalContent,
            },
            {
              key: 'layout',
              label: 'Layout',
              children: layoutContent,
            },
          ]}
        />
      </Form>
    </Modal>
  );
};
