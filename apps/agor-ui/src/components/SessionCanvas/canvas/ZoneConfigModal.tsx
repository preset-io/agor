/**
 * Modal for configuring zone identity, appearance, placement, and automation.
 */

import type { AgenticToolName, BoardObject } from '@agor-live/client';
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
import { toTranslucentZoneFill, ZONE_CONTENT_OPACITY } from './zoneAppearance';
import {
  applyZoneConfigDraft,
  createZoneConfigDraft,
  type ZoneConfigDraft,
} from './zoneConfigDraft';
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
  canEdit?: boolean;
}

type ZoneFormValues = Pick<
  ZoneConfigDraft,
  'name' | 'locked' | 'triggerBehavior' | 'triggerTemplate'
>;

export const ZoneConfigModal = ({
  open,
  onCancel,
  zoneName,
  objectId,
  onUpdate,
  zoneData,
  canEdit = true,
}: ZoneConfigModalProps) => {
  const { token } = theme.useToken();
  const [form] = Form.useForm<ZoneFormValues>();
  const [triggerAgent, setTriggerAgent] = useState<AgenticToolName | null>('claude-code');
  const [borderColor, setBorderColor] = useState<string | undefined>();
  const [backgroundColor, setBackgroundColor] = useState<string | undefined>();
  const [fontSize, setFontSize] = useState<number | undefined>();
  const [clearLegacyColor, setClearLegacyColor] = useState(false);
  const initialDraftRef = useRef<{ objectId: string; draft: ZoneConfigDraft } | null>(null);
  const savingRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const mutationGate = useMutationGate();

  const triggerBehavior = Form.useWatch('triggerBehavior', form);
  const triggerTemplate = Form.useWatch('triggerTemplate', form);
  const automationActive = Boolean(triggerTemplate?.trim());
  const zone = zoneData.type === 'zone' ? zoneData : undefined;
  const zoneTrigger = zone?.trigger;
  const zoneTriggerAgent = zoneTrigger?.agent;
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

  // Keep the opening baseline: live patches must neither erase the draft nor
  // turn untouched fields into edits. A different zone/open gets a fresh draft.
  useEffect(() => {
    if (open && zone && initialDraftRef.current?.objectId !== objectId) {
      const draft = createZoneConfigDraft(zone, zoneName);
      initialDraftRef.current = { objectId, draft };
      form.setFieldsValue(draft);
      setBorderColor(draft.borderColor);
      setBackgroundColor(draft.backgroundColor);
      setFontSize(draft.fontSize);
      setClearLegacyColor(false);
      setTriggerAgent(draft.triggerAgent);
    } else if (!open) {
      initialDraftRef.current = null;
    }
  }, [open, objectId, zone, zoneName, form]);

  // Validation yields. Re-read props before constructing the replacement so a
  // received patch or permission change during validation is not lost.
  const latestRef = useRef({ zone, objectId, open, canEdit, mutationGate, onUpdate, onCancel });
  latestRef.current = { zone, objectId, open, canEdit, mutationGate, onUpdate, onCancel };
  useEffect(
    () => () => {
      initialDraftRef.current = null;
    },
    []
  );

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
      savingRef.current ||
      !mutationGate.canMutate ||
      !canEdit ||
      requiresSupportedToolSelection ||
      triggerAgent === null
    )
      return;
    const initial = initialDraftRef.current;
    if (!initial) return;
    // Guard synchronously as well as disabling the UI, including validation.
    savingRef.current = true;
    setIsSaving(true);
    try {
      const values = await form.validateFields();
      const latest = latestRef.current;
      if (
        initialDraftRef.current !== initial ||
        !latest.open ||
        !latest.zone ||
        latest.objectId !== initial.objectId ||
        !latest.canEdit ||
        !latest.mutationGate.canMutate
      )
        return;
      const nextZone = applyZoneConfigDraft(latest.zone, initial.draft, {
        ...values,
        // Preserve the opening value if a field ever fails to register.
        name: values.name ?? initial.draft.name,
        locked: values.locked ?? initial.draft.locked,
        triggerAgent,
        borderColor,
        backgroundColor,
        fontSize,
        clearLegacyColor,
      });
      if (nextZone) {
        const saved = await latest.onUpdate(initial.objectId, nextZone);
        if (saved === false) return;
      }
      if (initialDraftRef.current === initial && latestRef.current.open) {
        latestRef.current.onCancel();
      }
    } catch {
      // Validation or persistence failed; retain the draft for retry.
    } finally {
      savingRef.current = false;
      setIsSaving(false);
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
              disabled={isSaving}
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
              disabled={isSaving || (borderColor === undefined && legacyColor === undefined)}
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
              disabled={isSaving}
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
              disabled={isSaving || (backgroundColor === undefined && legacyColor === undefined)}
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
            <Button
              disabled={isSaving || fontSize === undefined}
              onClick={() => setFontSize(undefined)}
            >
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

  return (
    <Modal
      title="Zone settings"
      open={open}
      onCancel={() => {
        if (!savingRef.current) onCancel();
      }}
      confirmLoading={isSaving}
      cancelButtonProps={{ disabled: isSaving }}
      closable={!isSaving}
      mask={{ closable: !isSaving }}
      keyboard={!isSaving}
      onOk={handleSave}
      okText="Save"
      okButtonProps={{
        disabled: isSaving || !mutationGate.canMutate || !canEdit || requiresSupportedToolSelection,
      }}
      cancelText="Cancel"
      width={640}
    >
      {/* Inert also covers custom agent cards that do not consume Form.disabled. */}
      <Form form={form} layout="vertical" disabled={isSaving} inert={isSaving}>
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
              // Force-render so Form.Item name="name" registers with the Form
              // instance even if the user saves without ever visiting this tab
              // (otherwise validateFields() omits `name` and the save wipes it).
              forceRender: true,
            },
          ]}
        />
      </Form>
    </Modal>
  );
};
