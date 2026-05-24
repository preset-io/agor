/**
 * Schedule create / edit modal.
 *
 * Per §6b of docs/internal/schedules-first-class-design-2026-05-24.md the
 * field order is: name + description → prompt textarea (prominent) → cron
 * + timezone → compact agent picker → advanced (enabled / retention /
 * concurrency).
 *
 * Uses `react-js-cron` for the visual cron picker and `cronstrue` (via
 * the shared `humanizeCron` helper) for the live "Every hour" preview.
 */

import type { AgenticToolName, AgorClient, BranchID, MCPServer, Schedule } from '@agor-live/client';
import { humanizeCron } from '@agor-live/client';
import {
  Alert,
  Button,
  Collapse,
  Divider,
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
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

// A reasonable curated subset for the IANA dropdown; we also accept
// free-text via Select's showSearch fallback so power users aren't
// limited.
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
  /** MCP server catalog for the AgenticToolConfigForm. */
  mcpServerById: Map<string, MCPServer>;
  /** Feathers client. */
  client: AgorClient | null;
  /** Fires after a successful create OR patch with the saved schedule. */
  onSaved?: (schedule: Schedule) => void;
}

const DEFAULT_CRON = '0 * * * *';

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
  const [form] = Form.useForm();

  const [name, setName] = useState(schedule?.name ?? '');
  const [description, setDescription] = useState(schedule?.description ?? '');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const [cron, setCron] = useState(schedule?.cron_expression ?? DEFAULT_CRON);
  const [timezoneMode, setTimezoneMode] = useState<'local' | 'utc'>(
    schedule?.timezone_mode ?? 'local'
  );
  const [timezone, setTimezone] = useState<string>(schedule?.timezone ?? detectBrowserTz());
  const [agentTool, setAgentTool] = useState<AgenticToolName>(
    (schedule?.agentic_tool_config?.agentic_tool as AgenticToolName) ?? 'claude-code'
  );
  const [enabled, setEnabled] = useState<boolean>(schedule?.enabled ?? true);
  const [retention, setRetention] = useState<number>(schedule?.retention ?? 5);
  const [allowConcurrentRuns, setAllowConcurrentRuns] = useState<boolean>(
    schedule?.allow_concurrent_runs ?? false
  );
  const [showCronPicker, setShowCronPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset state when the schedule prop changes (edit -> different edit, or
  // edit -> create after the modal stays mounted across open/close cycles).
  useEffect(() => {
    if (!open) return;
    setName(schedule?.name ?? '');
    setDescription(schedule?.description ?? '');
    setPrompt(schedule?.prompt ?? '');
    setCron(schedule?.cron_expression ?? DEFAULT_CRON);
    setTimezoneMode(schedule?.timezone_mode ?? 'local');
    setTimezone(schedule?.timezone ?? detectBrowserTz());
    setAgentTool((schedule?.agentic_tool_config?.agentic_tool as AgenticToolName) ?? 'claude-code');
    setEnabled(schedule?.enabled ?? true);
    setRetention(schedule?.retention ?? 5);
    setAllowConcurrentRuns(schedule?.allow_concurrent_runs ?? false);
    form.resetFields();
  }, [open, schedule, form]);

  const humanizedCron = useMemo(() => {
    try {
      return humanizeCron(cron);
    } catch {
      return null;
    }
  }, [cron]);

  const handleSave = async (runAfter = false) => {
    if (!client) {
      showError('Not connected to daemon');
      return;
    }
    if (!name.trim()) {
      showError('Name is required');
      return;
    }
    if (!prompt.trim()) {
      showError('Prompt is required');
      return;
    }
    if (timezoneMode === 'local' && !timezone) {
      showError("Timezone is required when mode is 'local'");
      return;
    }

    setSaving(true);
    try {
      const payload: Partial<Schedule> = {
        branch_id: branchId,
        name: name.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim(),
        cron_expression: cron,
        timezone_mode: timezoneMode,
        timezone: timezoneMode === 'local' ? timezone : undefined,
        // AgenticToolConfigForm uses a separate Form instance and we don't
        // thread its values into our state; advanced fields default to the
        // current schedule's config when editing. (Power-user flow.)
        agentic_tool_config: {
          ...(schedule?.agentic_tool_config ?? {}),
          agentic_tool: agentTool,
        },
        enabled,
        retention,
        allow_concurrent_runs: allowConcurrentRuns,
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
      <Form form={form} layout="vertical">
        <Form.Item label="Name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Hourly heartbeat"
          />
        </Form.Item>

        <Form.Item label="Description">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </Form.Item>

        <Divider>Prompt</Divider>
        <Form.Item label="Prompt template" required>
          <TextArea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Review the current state of {{branch.name}} and post a status update."
            rows={6}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Handlebars: <code>{'{{branch.*}}'}</code> <code>{'{{board.*}}'}</code>{' '}
            <code>{'{{schedule.*}}'}</code>
          </Text>
        </Form.Item>

        <Divider>When</Divider>
        <Form.Item label="Cron expression" required>
          <Space.Compact style={{ width: '100%' }}>
            <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 * * * *" />
            <Button onClick={() => setShowCronPicker((s) => !s)}>
              {showCronPicker ? 'Hide picker' : 'Edit visually'}
            </Button>
          </Space.Compact>
          {humanizedCron && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
              ⓘ {humanizedCron}
            </Text>
          )}
          {showCronPicker && (
            <div style={{ marginTop: 12 }}>
              <Cron value={cron} setValue={(v: string) => setCron(v)} clearButton={false} />
            </div>
          )}
        </Form.Item>

        <Form.Item label="Timezone">
          <Radio.Group
            value={timezoneMode}
            onChange={(e) => setTimezoneMode(e.target.value as 'local' | 'utc')}
          >
            <Radio value="local">Local time</Radio>
            <Radio value="utc">UTC</Radio>
          </Radio.Group>
          {timezoneMode === 'local' && (
            <Select
              showSearch
              style={{ display: 'block', marginTop: 8, width: 320 }}
              value={timezone}
              onChange={setTimezone}
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
          )}
        </Form.Item>

        <Divider>Agent</Divider>
        <Form.Item>
          <AgentSelectionGrid
            agents={AVAILABLE_AGENTS}
            selectedAgentId={agentTool}
            onSelect={(id) => setAgentTool(id as AgenticToolName)}
            columns={3}
          />
        </Form.Item>
        <Collapse
          ghost
          items={[
            {
              key: 'advanced-agent',
              label: 'Advanced agent settings (permission, model, MCPs)',
              children: (
                <AgenticToolConfigForm
                  agenticTool={agentTool}
                  mcpServerById={mcpServerById}
                  compact
                  client={client}
                />
              ),
            },
          ]}
        />

        <Divider>Advanced</Divider>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Form.Item label="Enabled" style={{ marginBottom: 0 }}>
            <Switch checked={enabled} onChange={setEnabled} />
          </Form.Item>
          <Form.Item label="Retention (sessions to keep; 0 = keep all)" style={{ marginBottom: 0 }}>
            <InputNumber min={0} value={retention} onChange={(v) => setRetention(v ?? 5)} />
          </Form.Item>
          <Form.Item label="Concurrency" style={{ marginBottom: 0 }}>
            <Radio.Group
              value={allowConcurrentRuns ? 'allow' : 'block'}
              onChange={(e) => setAllowConcurrentRuns(e.target.value === 'allow')}
            >
              <Radio value="block">Block (default)</Radio>
              <Radio value="allow">Allow concurrent runs</Radio>
            </Radio.Group>
          </Form.Item>
        </Space>

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
