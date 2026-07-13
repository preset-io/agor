/**
 * Schedule create / edit modal.
 *
 * Mirrors the structure of `NewSessionModal` for visual + ergonomic
 * consistency:
 *
 * - Primary fields top: name, description, prompt, cron + timezone, agent,
 *   MCP servers.
 * - Ghost `<Collapse>` with two panels for the secondary zone:
 *     1. "Agentic Tool Configuration" — the same preset-or-inline picker
 *        the session modal uses. MCP selection remains a sibling field and
 *        is never persisted inside a preset.
 *     2. "Schedule Settings" — retention + concurrency (schedule-specific).
 *
 * Reuses the same building blocks as `NewSessionModal`:
 * - `AgentSelectionGrid` (with `variant="select"` here vs `cards` there —
 *   schedules don't need to merchandise the agent choice).
 * - `SessionMcpServersField` as a top-level form field.
 * - `AgenticToolConfigurationPicker` plus independent MCP selection.
 * - `getFormValuesFromConfig` / `buildConfigFromFormValues` to translate
 *   between form values and the schedule's `agentic_tool_config` jsonb.
 *
 * Field order for the primary zone follows §6b of the design doc: name +
 * description → prompt → cron + timezone → agent → MCP.
 */

import type { AgenticToolName, AgorClient, BranchID, MCPServer, Schedule } from '@agor-live/client';
import { humanizeCron } from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import {
  Alert,
  AutoComplete,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Cron } from 'react-js-cron';
import 'react-js-cron/dist/styles.css';
import { useThemedMessage } from '../../utils/message';
import {
  type AgenticFormValues,
  buildScheduleConfigFromFormValues,
  getFormValuesFromConfig,
  scheduleConfigToDefaultConfig,
} from '../AgenticToolConfigForm';
import {
  AgenticToolConfigurationPicker,
  INLINE_AGENTIC_CONFIGURATION,
} from '../AgenticToolConfigurationPicker';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';

const { TextArea } = Input;
const { Text } = Typography;

// Curated IANA timezone list shown in the timezone AutoComplete; users
// can also type any other IANA zone (validated server-side).
const COMMON_TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
] as const;

function detectBrowserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface ScheduleModalProps {
  open: boolean;
  onClose: () => void;
  /** The branch the schedule belongs to (required for create). */
  branchId: BranchID;
  branchName: string;
  /** Existing schedule when editing; null/undefined when creating. */
  schedule?: Schedule | null;
  /** MCP server catalog. */
  mcpServerById: Map<string, MCPServer>;
  /** Feathers client. */
  client: AgorClient | null;
  /** Fires after a successful create OR patch with the saved schedule. */
  onSaved?: (schedule: Schedule) => void;
}

const DEFAULT_CRON = '0 * * * *';

// ScheduleModal carries schedule-specific fields (cron/tz/retention/etc.)
// plus the shared `AgenticFormValues` shape that AgenticToolConfigForm and
// its helpers read/write. Spreading the shared interface keeps the field
// names in lockstep with NewSessionModal and the agenticConfigHelpers.
interface ScheduleFormValues extends AgenticFormValues {
  mcpServerIds?: string[];
  agenticToolPresetId?: string;
  name?: string;
  description?: string;
  prompt?: string;
  cron_expression?: string;
  timezone_mode?: 'local' | 'utc';
  timezone?: string;
  agenticTool?: AgenticToolName;
  enabled?: boolean;
  retention?: number;
  allow_concurrent_runs?: boolean;
}

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  open,
  onClose,
  branchId,
  branchName,
  schedule,
  mcpServerById,
  client,
  onSaved,
}) => {
  const isEditing = Boolean(schedule?.schedule_id);
  const { showError, showSuccess } = useThemedMessage();
  const [form] = Form.useForm<ScheduleFormValues>();

  // Agent picker is controlled via local state because it drives which
  // fields AgenticToolConfigForm shows (e.g., effort for Claude only).
  // The selected value is mirrored into the form as `agenticTool` so save
  // can read it consistently with the rest of the form.
  const [agentTool, setAgentTool] = useState<AgenticToolName>(
    (schedule?.agentic_tool_config?.agentic_tool as AgenticToolName) ?? 'claude-code'
  );
  const [showCronPicker, setShowCronPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  // Initialize form when modal opens or the schedule prop changes.
  useEffect(() => {
    if (!open) return;
    const tool = (schedule?.agentic_tool_config?.agentic_tool as AgenticToolName) ?? 'claude-code';
    const configValues = getFormValuesFromConfig(
      tool,
      scheduleConfigToDefaultConfig(schedule?.agentic_tool_config)
    );
    setAgentTool(tool);
    setShowCronPicker(false);
    form.resetFields();
    form.setFieldsValue({
      name: schedule?.name ?? '',
      description: schedule?.description ?? '',
      prompt: schedule?.prompt ?? '',
      cron_expression: schedule?.cron_expression ?? DEFAULT_CRON,
      timezone_mode: schedule?.timezone_mode ?? 'local',
      timezone: schedule?.timezone ?? detectBrowserTz(),
      agenticTool: tool,
      agenticToolPresetId: schedule?.agentic_tool_config?.preset_id ?? INLINE_AGENTIC_CONFIGURATION,
      enabled: schedule?.enabled ?? true,
      retention: schedule?.retention ?? 5,
      allow_concurrent_runs: schedule?.allow_concurrent_runs ?? false,
      ...configValues,
      mcpServerIds: schedule?.mcp_server_ids ?? [],
    });
  }, [open, schedule, form]);

  // Reseed AgenticToolConfigForm fields ONLY when the user actually
  // changes the agent — not on mount/open. A useEffect keyed on
  // `agentTool` would clobber the just-loaded saved values on every
  // edit-open (the original ScheduleTab carried the same warning).
  const handleAgentToolChange = (next: AgenticToolName) => {
    if (next === agentTool) return;
    setAgentTool(next);
    const defaults = getFormValuesFromConfig(next);
    form.setFieldsValue({
      ...defaults,
      agenticTool: next,
      agenticToolPresetId: undefined,
      ...(next !== 'codex' && {
        codexSandboxMode: undefined,
        codexApprovalPolicy: undefined,
        codexNetworkAccess: undefined,
      }),
    });
  };

  const cronValue = Form.useWatch('cron_expression', form) ?? DEFAULT_CRON;
  const timezoneModeValue = Form.useWatch('timezone_mode', form) ?? 'local';

  const humanizedCron = useMemo(() => {
    try {
      return humanizeCron(cronValue);
    } catch {
      return null;
    }
  }, [cronValue]);

  const handleSave = async () => {
    if (!client) {
      showError('Not connected to daemon');
      return;
    }
    let values: ScheduleFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (values.timezone_mode === 'local' && !values.timezone) {
      showError("Timezone is required when mode is 'local'");
      return;
    }
    // `getFieldsValue(true)` includes fields rendered inside collapsed
    // panels (which validateFields can skip).
    const all = { ...form.getFieldsValue(true), ...values } as ScheduleFormValues;

    setSaving(true);
    try {
      const payload: Partial<Schedule> = {
        branch_id: branchId,
        name: (all.name ?? '').trim(),
        description: all.description?.trim() || undefined,
        prompt: (all.prompt ?? '').trim(),
        cron_expression: all.cron_expression ?? DEFAULT_CRON,
        timezone_mode: all.timezone_mode ?? 'local',
        timezone: all.timezone_mode === 'local' ? all.timezone : undefined,
        agentic_tool_config:
          all.agenticToolPresetId && all.agenticToolPresetId !== INLINE_AGENTIC_CONFIGURATION
            ? {
                agentic_tool: agentTool,
                preset_id: all.agenticToolPresetId as Schedule['agentic_tool_config']['preset_id'],
              }
            : buildScheduleConfigFromFormValues(
                agentTool,
                {
                  modelConfig: all.modelConfig,
                  effort: all.effort,
                  permissionMode: all.permissionMode,
                  codexSandboxMode: all.codexSandboxMode,
                  codexApprovalPolicy: all.codexApprovalPolicy,
                  codexNetworkAccess: all.codexNetworkAccess,
                },
                schedule?.agentic_tool_config
              ),
        mcp_server_ids: all.mcpServerIds ?? [],
        enabled: all.enabled ?? true,
        retention: all.retention ?? 5,
        allow_concurrent_runs: all.allow_concurrent_runs ?? false,
      };

      let saved: Schedule;
      if (isEditing && schedule?.schedule_id) {
        saved = await client.service('schedules').patch(schedule.schedule_id, payload);
      } else {
        saved = await client.service('schedules').create(payload);
      }

      showSuccess(isEditing ? 'Schedule updated' : 'Schedule created');
      onSaved?.(saved);
      onClose();
    } catch (e: unknown) {
      showError(e instanceof Error ? e.message : 'Failed to save schedule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEditing ? `Edit schedule — ${schedule?.name}` : `New schedule for ${branchName}`}
      open={open}
      onCancel={onClose}
      width={760}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onClose} disabled={saving}>
          Cancel
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={handleSave}>
          {isEditing ? 'Save' : 'Create'}
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical" preserve={false} style={{ marginTop: 16 }}>
        <Form.Item name="enabled" label="Enabled" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item
          name="name"
          label="Name"
          rules={[{ required: true, message: 'Name is required' }]}
        >
          <Input placeholder="Hourly heartbeat" />
        </Form.Item>

        <Form.Item name="description" label="Description (optional)">
          <Input placeholder="What this schedule does" />
        </Form.Item>

        <Form.Item
          name="prompt"
          label="Prompt template"
          rules={[{ required: true, message: 'Prompt is required' }]}
          help={
            <Text type="secondary" style={{ fontSize: 12 }}>
              Handlebars: <code>{'{{branch.*}}'}</code> <code>{'{{schedule.*}}'}</code>
            </Text>
          }
        >
          <TextArea
            placeholder="Review the current state of {{branch.name}} and post a status update."
            rows={6}
          />
        </Form.Item>

        <Form.Item
          name="cron_expression"
          label="Cron expression"
          rules={[{ required: true, message: 'Cron is required' }]}
          extra={
            <>
              {humanizedCron && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ⓘ {humanizedCron}
                </Text>
              )}
              {showCronPicker && (
                <div style={{ marginTop: 12 }}>
                  <Cron
                    value={cronValue}
                    setValue={(v: string) => form.setFieldValue('cron_expression', v)}
                    clearButton={false}
                  />
                </div>
              )}
            </>
          }
        >
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={cronValue}
              onChange={(e) => form.setFieldValue('cron_expression', e.target.value)}
              placeholder="0 * * * *"
            />
            <Button onClick={() => setShowCronPicker((s) => !s)}>
              {showCronPicker ? 'Hide picker' : 'Edit visually'}
            </Button>
          </Space.Compact>
        </Form.Item>

        <Form.Item name="timezone_mode" label="Timezone mode">
          <Radio.Group>
            <Radio value="local">Local time</Radio>
            <Radio value="utc">UTC</Radio>
          </Radio.Group>
        </Form.Item>

        {timezoneModeValue === 'local' && (
          <Form.Item
            name="timezone"
            label="Timezone"
            rules={[{ required: true, message: 'Timezone is required in local mode' }]}
          >
            <AutoComplete
              // AutoComplete lets the user pick from the curated list OR
              // type any other IANA zone. The server-side validator
              // (validateScheduleConfig) rejects unknown zones via
              // Intl.DateTimeFormat, so free entry is safe here.
              options={COMMON_TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
              filterOption={(input, option) =>
                (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
              placeholder="Type or pick an IANA zone (e.g. America/Los_Angeles, Asia/Bangkok)"
            />
          </Form.Item>
        )}

        <Form.Item label="Agentic tool">
          <AgentSelectionGrid
            agents={AVAILABLE_AGENTS}
            selectedAgentId={agentTool}
            onSelect={(id) => handleAgentToolChange(id as AgenticToolName)}
            variant="select"
          />
        </Form.Item>

        <AgenticToolConfigurationPicker
          tool={agentTool}
          mcpServerById={mcpServerById}
          client={client}
        />

        <Collapse
          ghost
          destroyOnHidden={false}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'schedule-settings',
              label: <Typography.Text strong>Schedule Settings</Typography.Text>,
              children: (
                <>
                  <Form.Item name="retention" label="Retention (sessions to keep; 0 = keep all)">
                    <InputNumber min={0} />
                  </Form.Item>
                  <Form.Item
                    name="allow_concurrent_runs"
                    label="Concurrency"
                    extra="Controls overlap for this schedule only; sibling schedules on the same branch are independent."
                  >
                    <Radio.Group>
                      <Radio value={false}>
                        Block overlapping runs from this schedule (default)
                      </Radio>
                      <Radio value={true}>Allow overlapping runs from this schedule</Radio>
                    </Radio.Group>
                  </Form.Item>
                </>
              ),
            },
          ]}
          style={{ marginTop: 16 }}
        />

        {!isEditing && (
          <Alert
            style={{ marginTop: 16 }}
            type="info"
            showIcon
            message="Catchup is disabled by default."
            description="If the daemon is down when a fire is due, only the most recent missed run within the 2-minute grace window will fire. No backfill."
          />
        )}
      </Form>
    </Modal>
  );
};
