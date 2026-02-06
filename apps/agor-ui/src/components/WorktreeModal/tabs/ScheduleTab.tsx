import type { AgenticToolName, MCPServer, Worktree } from '@agor/core/types';
import { getDefaultPermissionMode } from '@agor/core/types';
import { ClockCircleOutlined, PlayCircleOutlined, StopOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Divider,
  Form,
  Input,
  InputNumber,
  message,
  Space,
  Switch,
  Typography,
} from 'antd';
import cronstrue from 'cronstrue';
import { useEffect, useState } from 'react';
import { Cron } from 'react-js-cron';
import 'react-js-cron/dist/styles.css';
import { AgenticToolConfigForm } from '../../AgenticToolConfigForm';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../../AgentSelectionGrid';

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

interface ScheduleTabProps {
  worktree: Worktree;
  mcpServerById?: Map<string, MCPServer>;
  onUpdate?: (worktreeId: string, updates: Partial<Worktree>) => void;
}

export const ScheduleTab: React.FC<ScheduleTabProps> = ({
  worktree,
  mcpServerById = new Map(),
  onUpdate,
}) => {
  const [form] = Form.useForm();
  const [isInitialized, setIsInitialized] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(worktree.schedule_enabled || false);
  const [cronExpression, setCronExpression] = useState(worktree.schedule_cron || '0 0 * * *');
  const [agenticTool, setAgenticTool] = useState<string>(
    worktree.schedule?.agentic_tool || 'claude-code'
  );
  const [retention, setRetention] = useState<number>(worktree.schedule?.retention || 5);
  const [promptTemplate, setPromptTemplate] = useState<string>(
    worktree.schedule?.prompt_template || ''
  );
  const [humanReadable, setHumanReadable] = useState<string>('');

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

  // Update permission mode when agent changes
  useEffect(() => {
    if (agenticTool) {
      form.setFieldValue(
        'permissionMode',
        getDefaultPermissionMode(agenticTool as AgenticToolName)
      );
    }
  }, [agenticTool, form]);

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
      const formValues = form.getFieldsValue();

      // Build schedule config object
      const scheduleConfig = {
        timezone: 'UTC',
        prompt_template: promptTemplate,
        agentic_tool: agenticTool as 'claude-code' | 'codex' | 'gemini',
        retention: retention,
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
      message.error('Failed to save schedule configuration');
      console.error('Error saving schedule:', error);
    }
  };

  // Get current form values to detect changes
  const formValues = form.getFieldsValue();

  const hasChanges =
    scheduleEnabled !== (worktree.schedule_enabled || false) ||
    cronExpression !== (worktree.schedule_cron || '0 0 * * *') ||
    agenticTool !== (worktree.schedule?.agentic_tool || 'claude-code') ||
    retention !== (worktree.schedule?.retention || 5) ||
    promptTemplate !== (worktree.schedule?.prompt_template || '') ||
    formValues.permissionMode !==
      (worktree.schedule?.permission_mode ||
        getDefaultPermissionMode(agenticTool as AgenticToolName)) ||
    JSON.stringify(formValues.modelConfig) !== JSON.stringify(worktree.schedule?.model_config) ||
    JSON.stringify(formValues.mcpServerIds) !==
      JSON.stringify(worktree.schedule?.mcp_server_ids || []);

  return (
    <div style={{ padding: '24px' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* Enable/Disable Schedule */}
        <Card size="small">
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
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
                message="The scheduler will automatically create new sessions based on the configuration below."
                type="success"
                showIcon
                icon={<ClockCircleOutlined />}
              />
            )}
          </Space>
        </Card>

        {/* Cron Expression */}
        <Card size="small" title="Schedule Frequency">
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                Configure when to create new sessions
              </Text>
            </div>

            {/* Cron Editor */}
            <Cron
              value={cronExpression}
              setValue={setCronExpression}
              allowedPeriods={['year', 'month', 'week', 'day', 'hour', 'minute']}
              allowedDropdowns={['period', 'months', 'month-days', 'week-days', 'hours', 'minutes']}
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
              message={humanReadable}
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
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: '12px' }}>
              Choose which coding agent will run the scheduled sessions
            </Text>
            <AgentSelectionGrid
              agents={AVAILABLE_AGENTS}
              selectedAgentId={agenticTool}
              onSelect={setAgenticTool}
              columns={2}
              showComparisonLink={true}
            />
          </Space>
        </Card>

        {/* Agent Configuration (collapsible advanced settings) */}
        <Collapse
          ghost
          items={[
            {
              key: 'agent-config',
              label: 'Advanced Agent Settings',
              children: (
                <Form form={form} layout="vertical">
                  <AgenticToolConfigForm
                    agenticTool={agenticTool as AgenticToolName}
                    mcpServerById={mcpServerById}
                    showHelpText={true}
                  />
                </Form>
              ),
            },
          ]}
        />

        {/* Prompt Template */}
        <Card size="small" title="Prompt Template">
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
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
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
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

        <Divider style={{ margin: '12px 0' }} />

        {/* Save Button */}
        <Space>
          <Button type="primary" onClick={handleSave} disabled={!hasChanges}>
            Save Schedule Configuration
          </Button>
          {hasChanges && (
            <Text type="warning" style={{ fontSize: '12px' }}>
              You have unsaved changes
            </Text>
          )}
        </Space>
      </Space>
    </div>
  );
};
