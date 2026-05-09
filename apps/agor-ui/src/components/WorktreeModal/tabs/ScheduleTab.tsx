import type { AgenticToolName, MCPServer, Worktree } from '@agor-live/client';
import { getDefaultPermissionMode } from '@agor-live/client';
import {
  ClockCircleOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Divider,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
  Typography,
} from 'antd';
import cronstrue from 'cronstrue';
import { useEffect, useState } from 'react';
import { Cron } from 'react-js-cron';
import 'react-js-cron/dist/styles.css';
import { useThemedMessage } from '../../../utils/message';
import { AgenticToolConfigForm } from '../../AgenticToolConfigForm';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../../AgentSelectionGrid';

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

interface ScheduleTabProps {
  worktree: Worktree;
  mcpServerById?: Map<string, MCPServer>;
  onUpdate?: (worktreeId: string, updates: Partial<Worktree>) => void;
  onExecuteScheduleNow?: (worktreeId: string) => Promise<void>;
}

export const ScheduleTab: React.FC<ScheduleTabProps> = ({
  worktree,
  mcpServerById = new Map(),
  onUpdate,
  onExecuteScheduleNow,
}) => {
  const [form] = Form.useForm();
  const { showError } = useThemedMessage();
  const [isInitialized, setIsInitialized] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(worktree.schedule_enabled || false);
  const [cronExpression, setCronExpression] = useState(worktree.schedule_cron || '0 0 * * *');
  const [agenticTool, setAgenticTool] = useState<string>(
    worktree.schedule?.agentic_tool || 'claude-code'
  );
  const [retention, setRetention] = useState<number>(worktree.schedule?.retention || 5);
  const [allowConcurrentRuns, setAllowConcurrentRuns] = useState<boolean>(
    worktree.schedule?.allow_concurrent_runs === true
  );
  const [promptTemplate, setPromptTemplate] = useState<string>(
    worktree.schedule?.prompt_template || ''
  );
  const [humanReadable, setHumanReadable] = useState<string>('');
  const [isExecutingNow, setIsExecutingNow] = useState(false);

  // Initialize local state and form on first mount
  useEffect(() => {
    if (!isInitialized) {
      // Read from schedule object if it exists, otherwise use defaults
      const scheduleConfig = worktree.schedule;
      const tool = (scheduleConfig?.agentic_tool || 'claude-code') as AgenticToolName;

      setScheduleEnabled(worktree.schedule_enabled || false);
      setCronExpression(worktree.schedule_cron || '0 0 * * *');
      setAgenticTool(tool);
      setRetention(scheduleConfig?.retention || 5);
      setAllowConcurrentRuns(scheduleConfig?.allow_concurrent_runs === true);
      setPromptTemplate(
        scheduleConfig?.prompt_template ||
          'Review the current state of the worktree and provide a status update.'
      );

      // Initialize form values
      form.setFieldsValue({
        permissionMode: scheduleConfig?.permission_mode || getDefaultPermissionMode(tool),
        mcpServerIds: scheduleConfig?.mcp_server_ids || [],
        modelConfig: scheduleConfig?.model_config,
      });

      setIsInitialized(true);
    }
  }, [isInitialized, worktree.schedule_enabled, worktree.schedule_cron, worktree.schedule, form]);

  // Reset permission mode when the user picks a different agent tool.
  // NOTE: This must NOT run on mount or remount — doing so would clobber the
  // saved permission_mode that the initialize effect above just loaded into
  // the form, causing the field to silently revert to the tool default on
  // every save round-trip.
  const handleAgenticToolChange = (newTool: string) => {
    if (newTool === agenticTool) return;
    setAgenticTool(newTool);
    form.setFieldValue('permissionMode', getDefaultPermissionMode(newTool as AgenticToolName));
  };

  // Update human-readable cron description
  useEffect(() => {
    try {
      const description = cronstrue.toString(cronExpression, { verbose: true });
      setHumanReadable(description);
    } catch (_error) {
      setHumanReadable('Invalid cron expression');
    }
  }, [cronExpression]);

  const handleSave = async () => {
    if (!onUpdate) return;

    try {
      // Get form values for advanced settings
      const formValues = form.getFieldsValue(true);

      // Build schedule config object
      const scheduleConfig = {
        timezone: 'UTC',
        prompt_template: promptTemplate,
        agentic_tool: agenticTool as 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'copilot',
        retention: retention,
        allow_concurrent_runs: allowConcurrentRuns,
        permission_mode: formValues.permissionMode,
        model_config: formValues.modelConfig,
        mcp_server_ids: formValues.mcpServerIds || [],
        created_at: worktree.schedule?.created_at || Date.now(),
        created_by: worktree.schedule?.created_by || worktree.created_by,
      };

      await onUpdate(worktree.worktree_id, {
        schedule_enabled: scheduleEnabled,
        schedule_cron: cronExpression,
        schedule: scheduleConfig,
      });
      // Note: onUpdate already shows a success toast, so we don't show another one here
    } catch (error) {
      showError('Failed to save schedule configuration');
      console.error('Error saving schedule:', error);
    }
  };

  // Get current form values to detect changes
  const formValues = form.getFieldsValue(true);

  const hasChanges =
    scheduleEnabled !== (worktree.schedule_enabled || false) ||
    cronExpression !== (worktree.schedule_cron || '0 0 * * *') ||
    agenticTool !== (worktree.schedule?.agentic_tool || 'claude-code') ||
    retention !== (worktree.schedule?.retention || 5) ||
    allowConcurrentRuns !== (worktree.schedule?.allow_concurrent_runs === true) ||
    promptTemplate !== (worktree.schedule?.prompt_template || '') ||
    formValues.permissionMode !==
      (worktree.schedule?.permission_mode ||
        getDefaultPermissionMode(agenticTool as AgenticToolName)) ||
    JSON.stringify(formValues.modelConfig) !== JSON.stringify(worktree.schedule?.model_config) ||
    JSON.stringify(formValues.mcpServerIds) !==
      JSON.stringify(worktree.schedule?.mcp_server_ids || []);

  return (
    <Form form={form} layout="vertical" component={false}>
      <div style={{ padding: '24px' }}>
        <Space orientation="vertical" size="large" style={{ width: '100%' }}>
          {/* Enable/Disable Schedule */}
          <Card size="small">
            <Space orientation="vertical" size="small" style={{ width: '100%' }}>
              <Space>
                <Switch
                  checked={scheduleEnabled}
                  onChange={setScheduleEnabled}
                  checkedChildren={<PlayCircleOutlined />}
                  unCheckedChildren={<StopOutlined />}
                />
                <Text strong>Enable Schedule</Text>
              </Space>
              {scheduleEnabled && (
                <Alert
                  title="The scheduler will automatically create new sessions based on the configuration below."
                  type="success"
                  showIcon
                  icon={<ClockCircleOutlined />}
                />
              )}
            </Space>
          </Card>

          {/* Cron Expression */}
          <Card size="small" title="Schedule Frequency">
            <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
              <div>
                <Text type="secondary" style={{ fontSize: '12px' }}>
                  Configure when to create new sessions. All cron expressions are evaluated in{' '}
                  <Text strong>UTC</Text> (your local time is{' '}
                  {new Date().toLocaleTimeString(undefined, { timeZoneName: 'short' })}).
                </Text>
              </div>

              {/* Cron Editor */}
              <Cron
                value={cronExpression}
                setValue={setCronExpression}
                allowedPeriods={['year', 'month', 'week', 'day', 'hour', 'minute']}
                allowedDropdowns={[
                  'period',
                  'months',
                  'month-days',
                  'week-days',
                  'hours',
                  'minutes',
                ]}
                mode="multiple"
                clockFormat="24-hour-clock"
                clearButton={true}
                clearButtonAction="fill-with-every"
                humanizeLabels={true}
                humanizeValue={false}
                leadingZero={true}
                shortcuts={['@yearly', '@monthly', '@weekly', '@daily', '@hourly']}
                allowEmpty="never"
                displayError={true}
              />

              {/* Human-readable description */}
              <Alert
                title={`${humanReadable} (UTC)`}
                type="info"
                showIcon
                icon={<ClockCircleOutlined />}
                style={{ marginTop: '8px' }}
              />

              {/* Manual cron input for advanced users */}
              <Form.Item label="Cron Expression" style={{ marginBottom: 0 }}>
                <Input
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  placeholder="0 0 * * *"
                  prefix={<ClockCircleOutlined />}
                />
              </Form.Item>
            </Space>
          </Card>

          {/* Agent Selection */}
          <Card size="small" title="Agent Selection">
            <Space orientation="vertical" size="small" style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                Choose which coding agent will run the scheduled sessions
              </Text>
              <AgentSelectionGrid
                agents={AVAILABLE_AGENTS}
                selectedAgentId={agenticTool}
                onSelect={handleAgenticToolChange}
                columns={2}
                showComparisonLink={true}
              />
            </Space>
          </Card>

          {/* Agent Configuration (collapsible advanced settings) */}
          <Collapse
            ghost
            destroyOnHidden={false}
            items={[
              {
                key: 'agent-config',
                label: 'Advanced Agent Settings',
                children: (
                  <AgenticToolConfigForm
                    agenticTool={agenticTool as AgenticToolName}
                    mcpServerById={mcpServerById}
                    showHelpText={true}
                  />
                ),
              },
            ]}
          />

          {/* Prompt Template */}
          <Card size="small" title="Prompt Template">
            <Space orientation="vertical" size="small" style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                Use Handlebars syntax for dynamic values. Available variables: worktree, board
              </Text>
              <TextArea
                value={promptTemplate}
                onChange={(e) => setPromptTemplate(e.target.value)}
                placeholder="Enter prompt template..."
                rows={6}
                style={{ fontFamily: 'monospace', fontSize: '13px' }}
              />
              <Paragraph type="secondary" style={{ fontSize: '11px', margin: 0 }}>
                Example: "Review worktree <code>{'{{worktree.name}}'}</code> and provide status
                update."
              </Paragraph>
            </Space>
          </Card>

          {/* Retention Policy */}
          <Card size="small" title="Retention Policy">
            <Space orientation="vertical" size="small" style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                Number of scheduled sessions to keep (0 = keep all)
              </Text>
              <Space.Compact>
                <InputNumber
                  value={retention}
                  onChange={(value) => setRetention(value || 0)}
                  min={0}
                  max={100}
                  style={{ width: '150px' }}
                />
                <Input value="sessions" disabled style={{ width: '80px', textAlign: 'center' }} />
              </Space.Compact>
            </Space>
          </Card>

          {/* Concurrency Policy */}
          <Card size="small" title="Concurrency">
            <Space orientation="vertical" size="small" style={{ width: '100%' }}>
              <Space>
                <Switch
                  checked={allowConcurrentRuns}
                  onChange={setAllowConcurrentRuns}
                  checkedChildren="Allow"
                  unCheckedChildren="Block"
                />
                <Text strong>Allow concurrent runs</Text>
              </Space>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                {allowConcurrentRuns
                  ? 'New runs will always start, even if another session is still active in this worktree.'
                  : 'If a session is already active in this worktree, scheduled runs are skipped and manual "Run now" triggers return an error. This is the default.'}
              </Text>
            </Space>
          </Card>

          <Divider style={{ margin: '12px 0' }} />

          {/* Save + Run Now Buttons */}
          <Space>
            <Button type="primary" onClick={handleSave} disabled={!hasChanges}>
              Save Schedule Configuration
            </Button>
            {onExecuteScheduleNow && (
              <Button
                icon={<ThunderboltOutlined />}
                loading={isExecutingNow}
                disabled={
                  isExecutingNow ||
                  hasChanges ||
                  !scheduleEnabled ||
                  !cronExpression ||
                  !promptTemplate
                }
                onClick={async () => {
                  setIsExecutingNow(true);
                  try {
                    await onExecuteScheduleNow(worktree.worktree_id);
                  } finally {
                    setIsExecutingNow(false);
                  }
                }}
                title={
                  hasChanges
                    ? 'Save your changes before running'
                    : !scheduleEnabled
                      ? 'Enable the schedule before running'
                      : 'Run this schedule immediately using the saved configuration'
                }
              >
                Run now
              </Button>
            )}
            {hasChanges && (
              <Text type="warning" style={{ fontSize: '12px' }}>
                You have unsaved changes
              </Text>
            )}
          </Space>
        </Space>
      </div>
    </Form>
  );
};
