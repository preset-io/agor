/**
 * Schedule create / edit modal.
 *
 * Mirrors the structure of `NewSessionModal` for visual + ergonomic
 * consistency:
 *
 * - Primary fields top: name, description, prompt, cron + timezone, agent,
 *   MCP servers.
 * - Ghost `<Collapse>` with two panels for the secondary zone:
 *     1. "Agentic Tool Configuration" — same `AgenticToolConfigForm`
 *        component the session modal uses, in `compact` mode + with
 *        `hideMcpServers` (the MCP field is promoted to the primary
 *        zone above).
 *     2. "Schedule Settings" — retention + concurrency (schedule-specific).
 *
 * Reuses the same building blocks as `NewSessionModal`:
 * - `AgentSelectionGrid` (with `variant="select"` here vs `cards` there —
 *   schedules don't need to merchandise the agent choice).
 * - `SessionMcpServersField` as a top-level form field.
 * - `AgenticToolConfigForm` with `hideMcpServers + compact`.
 * - `getFormValuesFromConfig` / `buildConfigFromFormValues` to translate
 *   between form values and the schedule's `agentic_tool_config` jsonb.
 *
 * Field order for the primary zone follows §6b of the design doc: name +
 * description → prompt → cron + timezone → agent → MCP.
 */

import type {
  AgenticToolName,
  AgorClient,
  BranchID,
  DefaultAgenticToolConfig,
  EffortLevel,
  MCPServer,
  Schedule,
  ScheduleAgenticToolConfig,
} from '@agor-live/client';
import { humanizeCron } from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Cron } from 'react-js-cron';
import 'react-js-cron/dist/styles.css';
import { useThemedMessage } from '../../utils/message';
import {
  AgenticToolConfigForm,
  buildConfigFromFormValues,
  getFormValuesFromConfig,
} from '../AgenticToolConfigForm';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { SessionMcpServersField } from '../MCPServerSelect';
import type { ModelConfig } from '../ModelSelector';

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

// Curated IANA timezone list; the Select stays `showSearch` so a power
// user can type any other zone name (e.g. `Asia/Bangkok`).
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

/**
 * Map the schedule's snake_case `agentic_tool_config` blob into the
 * camelCase shape the shared `AgenticToolConfigForm` (and its helpers)
 * expect.
 */
function scheduleConfigToDefaultConfig(
  cfg?: ScheduleAgenticToolConfig
): DefaultAgenticToolConfig | undefined {
  if (!cfg) return undefined;
  return {
    modelConfig: cfg.model_config
      ? // Bridge: ScheduleAgenticToolConfig.model_config is { mode, model? }
        // while DefaultAgenticToolConfig.modelConfig is the richer ModelConfig
        // shape (effort, provider, etc.). The fields we care about for the
        // form align; we cast through unknown so TS lets us bridge the
        // structurally-compatible-but-nominally-different types.
        (cfg.model_config as unknown as DefaultAgenticToolConfig['modelConfig'])
      : undefined,
    permissionMode: cfg.permission_mode as DefaultAgenticToolConfig['permissionMode'],
    mcpServerIds: cfg.mcp_server_ids,
    // Codex fields don't exist in ScheduleAgenticToolConfig today; they'd
    // need to be promoted if we ever want codex sandbox/approval/network
    // toggles on a schedule. Compact mode hides them anyway.
  };
}

/**
 * Inverse: pack form values back into the snake_case shape stored on
 * the schedule, preserving any fields we don't surface (e.g. context_files).
 */
function buildScheduleConfig(
  tool: AgenticToolName,
  formValues: {
    modelConfig?: ModelConfig;
    effort?: EffortLevel;
    permissionMode?: string;
    mcpServerIds?: string[];
    codexSandboxMode?: string;
    codexApprovalPolicy?: string;
    codexNetworkAccess?: boolean;
  },
  previous?: ScheduleAgenticToolConfig
): ScheduleAgenticToolConfig {
  const builtDefault = buildConfigFromFormValues(tool, formValues);
  return {
    ...previous,
    agentic_tool: tool,
    permission_mode: builtDefault.permissionMode as ScheduleAgenticToolConfig['permission_mode'],
    model_config: builtDefault.modelConfig as ScheduleAgenticToolConfig['model_config'],
    mcp_server_ids: builtDefault.mcpServerIds,
    // context_files is not edited in this modal; preserve from `previous` if present.
    context_files: previous?.context_files,
  };
}

interface ScheduleFormValues {
  name?: string;
  description?: string;
  prompt?: string;
  cron_expression?: string;
  timezone_mode?: 'local' | 'utc';
  timezone?: string;
  agenticTool?: AgenticToolName;
  // AgenticToolConfigForm field names (camelCase) — read by buildScheduleConfig.
  // Field types mirror `AgenticFormValues` in agenticConfigHelpers.ts; the
  // helpers themselves narrow to PermissionMode etc. on persistence.
  modelConfig?: ModelConfig;
  effort?: EffortLevel;
  permissionMode?: string;
  mcpServerIds?: string[];
  codexSandboxMode?: string;
  codexApprovalPolicy?: string;
  codexNetworkAccess?: boolean;
  // Schedule-settings panel
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
      enabled: schedule?.enabled ?? true,
      retention: schedule?.retention ?? 5,
      allow_concurrent_runs: schedule?.allow_concurrent_runs ?? false,
      ...configValues,
    });
  }, [open, schedule, form]);

  // When the agent changes, reseed the AgenticToolConfigForm fields with
  // sensible defaults for the new tool. Mirrors NewSessionModal's behavior.
  useEffect(() => {
    if (!open) return;
    const defaults = getFormValuesFromConfig(agentTool);
    form.setFieldsValue({
      ...defaults,
      agenticTool: agentTool,
      ...(agentTool !== 'codex' && {
        codexSandboxMode: undefined,
        codexApprovalPolicy: undefined,
        codexNetworkAccess: undefined,
      }),
    });
  }, [agentTool, open, form]);

  const cronValue = Form.useWatch('cron_expression', form) ?? DEFAULT_CRON;
  const timezoneModeValue = Form.useWatch('timezone_mode', form) ?? 'local';

  const humanizedCron = useMemo(() => {
    try {
      return humanizeCron(cronValue);
    } catch {
      return null;
    }
  }, [cronValue]);

  const handleSave = async (runAfter = false) => {
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
        agentic_tool_config: buildScheduleConfig(
          agentTool,
          {
            modelConfig: all.modelConfig,
            effort: all.effort,
            permissionMode: all.permissionMode,
            mcpServerIds: all.mcpServerIds,
            codexSandboxMode: all.codexSandboxMode,
            codexApprovalPolicy: all.codexApprovalPolicy,
            codexNetworkAccess: all.codexNetworkAccess,
          },
          schedule?.agentic_tool_config
        ),
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

      if (runAfter) {
        try {
          await client.service(`schedules/${saved.schedule_id}/run-now`).create({});
          showSuccess('Run triggered');
        } catch (e: unknown) {
          showError(e instanceof Error ? e.message : 'Failed to trigger run');
        }
      }

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
        <Button key="save" type="primary" loading={saving} onClick={() => handleSave(false)}>
          {isEditing ? 'Save' : 'Create'}
        </Button>,
        <Button
          key="save-and-run"
          loading={saving}
          onClick={() => handleSave(true)}
          title="Save and trigger a run immediately"
        >
          {isEditing ? 'Save & run' : 'Create & run'}
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
              Handlebars: <code>{'{{branch.*}}'}</code> <code>{'{{board.*}}'}</code>{' '}
              <code>{'{{schedule.*}}'}</code>
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
            <Select
              showSearch
              options={COMMON_TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <Paragraph type="secondary" style={{ fontSize: 11, padding: 8, margin: 0 }}>
                    Other IANA zones (e.g. <code>Asia/Bangkok</code>) can be typed.
                  </Paragraph>
                </>
              )}
            />
          </Form.Item>
        )}

        <Form.Item label="Agent">
          <AgentSelectionGrid
            agents={AVAILABLE_AGENTS}
            selectedAgentId={agentTool}
            onSelect={(id) => setAgentTool(id as AgenticToolName)}
            variant="select"
          />
        </Form.Item>

        {/* MCP Servers — promoted to the primary zone (mirrors NewSessionModal:252). */}
        <SessionMcpServersField mcpServerById={mcpServerById} />

        <Collapse
          ghost
          destroyOnHidden={false}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'agentic-tool-config',
              label: <Typography.Text strong>Agentic Tool Configuration</Typography.Text>,
              children: (
                <AgenticToolConfigForm
                  agenticTool={agentTool}
                  mcpServerById={mcpServerById}
                  hideMcpServers
                  compact
                  client={client}
                />
              ),
            },
            {
              key: 'schedule-settings',
              label: <Typography.Text strong>Schedule Settings</Typography.Text>,
              children: (
                <>
                  <Form.Item name="retention" label="Retention (sessions to keep; 0 = keep all)">
                    <InputNumber min={0} />
                  </Form.Item>
                  <Form.Item name="allow_concurrent_runs" label="Concurrency">
                    <Radio.Group>
                      <Radio value={false}>Block (default)</Radio>
                      <Radio value={true}>Allow concurrent runs</Radio>
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
