/**
 * Modal for handling zone triggers on worktree drops
 * Flow:
 * 1. Primary choice: Create new session OR Reuse existing session
 * 2. If reuse: Select session and choose action (Prompt/Fork/Spawn)
 */

import type {
  AgenticToolName,
  MCPServer,
  PermissionMode,
  Session,
  User,
  Worktree,
  WorktreeID,
  ZoneTrigger,
} from '@agor/core/types';

import { DownOutlined } from '@ant-design/icons';
import { Alert, Collapse, Form, Input, Modal, Radio, Select, Space, Typography } from 'antd';
import Handlebars from 'handlebars';
import { useEffect, useMemo, useState } from 'react';
import type { AgenticToolOption } from '../../../types';
import { AgenticToolConfigForm } from '../../AgenticToolConfigForm';
import { AgentSelectionGrid } from '../../AgentSelectionGrid';
import type { ModelConfig } from '../../ModelSelector';

interface ZoneTriggerModalProps {
  open: boolean;
  onCancel: () => void;
  worktreeId: WorktreeID;
  worktree: Worktree | undefined;
  sessions: Session[];
  zoneName: string;
  trigger: ZoneTrigger;
  boardName?: string;
  boardDescription?: string;
  boardCustomContext?: Record<string, unknown>;
  availableAgents: AgenticToolOption[];
  mcpServers: MCPServer[];
  currentUser?: User | null; // Optional - current user for default settings
  onExecute: (params: {
    sessionId: string | 'new';
    action: 'prompt' | 'fork' | 'spawn';
    renderedTemplate: string;
    // New session config (only when sessionId === 'new')
    agent?: string;
    modelConfig?: ModelConfig;
    permissionMode?: PermissionMode;
    mcpServerIds?: string[];
  }) => Promise<void>;
}

export const ZoneTriggerModal = ({
  open,
  onCancel,
  worktreeId,
  worktree,
  sessions,
  zoneName,
  trigger,
  boardName,
  boardDescription,
  boardCustomContext,
  availableAgents,
  mcpServers,
  currentUser,
  onExecute,
}: ZoneTriggerModalProps) => {
  const [form] = Form.useForm();

  // Primary mode: create new or reuse existing
  const [mode, setMode] = useState<'create_new' | 'reuse_existing'>('create_new');

  // Agent selection (only for create_new mode)
  const [selectedAgent, setSelectedAgent] = useState<string>('claude-code');

  // Session selection (only for reuse mode)
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');

  // Action selection (only for reuse mode)
  const [selectedAction, setSelectedAction] = useState<'prompt' | 'fork' | 'spawn'>('prompt');

  // Editable rendered template (user can modify before executing)
  const [editableTemplate, setEditableTemplate] = useState<string>('');

  // Explicit state for session config (survives form mount/unmount cycles)
  const [sessionConfig, setSessionConfig] = useState<{
    modelConfig?: ModelConfig;
    permissionMode?: PermissionMode;
    mcpServerIds?: string[];
  }>({});

  // Filter sessions for this worktree
  const worktreeSessions = useMemo(() => {
    return sessions.filter(s => s.worktree_id === worktreeId);
  }, [sessions, worktreeId]);

  // Smart default: Most recent active/completed session
  const smartDefaultSession = useMemo(() => {
    if (worktreeSessions.length === 0) return '';

    // Prioritize running sessions
    const runningSessions = worktreeSessions.filter(s => s.status === 'running');
    if (runningSessions.length > 0) {
      // Most recently updated running session
      return runningSessions.sort(
        (a, b) =>
          new Date(b.last_updated || b.created_at).getTime() -
          new Date(a.last_updated || a.created_at).getTime()
      )[0].session_id;
    }

    // Otherwise most recent session
    return worktreeSessions.sort(
      (a, b) =>
        new Date(b.last_updated || b.created_at).getTime() -
        new Date(a.last_updated || a.created_at).getTime()
    )[0].session_id;
  }, [worktreeSessions]);

  // Get the currently selected session (for pre-populating form on reuse)
  const selectedSession = useMemo(() => {
    return worktreeSessions.find(s => s.session_id === selectedSessionId);
  }, [selectedSessionId, worktreeSessions]);

  // Reset to defaults when modal opens
  useEffect(() => {
    if (open) {
      // Default to 'reuse_existing' if sessions are available, otherwise 'create_new'
      setMode(worktreeSessions.length > 0 ? 'reuse_existing' : 'create_new');
      setSelectedSessionId(smartDefaultSession);
      setSelectedAction('prompt');
      form.resetFields();
      setSessionConfig({}); // Clear session config state
    }
  }, [open, smartDefaultSession, form, worktreeSessions.length]);

  // Pre-populate form AND state when creating new session
  // Priority: Most recent session > User defaults > System defaults
  useEffect(() => {
    if (mode === 'create_new' && selectedAgent) {
      // Find the most recent session for this worktree (create a copy to avoid mutating the array)
      const mostRecentSession =
        worktreeSessions.length > 0
          ? [...worktreeSessions].sort(
              (a, b) =>
                new Date(b.last_updated || b.created_at).getTime() -
                new Date(a.last_updated || a.created_at).getTime()
            )[0]
          : null;

      // Get user defaults for this agent as fallback
      const agentDefaults = currentUser?.default_agentic_config?.[selectedAgent as AgenticToolName];

      // Calculate config values (priority: most recent session > user defaults)
      const configValues = {
        permissionMode: mostRecentSession?.permission_config?.mode || agentDefaults?.permissionMode,
        modelConfig:
          mostRecentSession?.model_config ||
          (agentDefaults?.modelConfig as ModelConfig | undefined),
        mcpServerIds: agentDefaults?.mcpServerIds || [],
      };

      // Store in both form (for UI) AND component state (for execution)
      form.setFieldsValue(configValues);
      setSessionConfig(configValues);
    }
  }, [mode, selectedAgent, currentUser, worktreeSessions, form]);

  // Pre-populate form with selected session's config when reusing
  useEffect(() => {
    if (mode === 'reuse_existing' && selectedSession) {
      // Pre-populate with session's current config
      form.setFieldsValue({
        agent: selectedSession.agentic_tool,
        permissionMode: selectedSession.permission_config?.mode,
        modelConfig: selectedSession.model_config,
        // Note: mcpServerIds would need to be fetched separately if we want to show them
      });
    }
  }, [mode, selectedSession, form]);

  // Render template preview
  const renderedTemplate = useMemo(() => {
    try {
      const context = {
        worktree: worktree
          ? {
              name: worktree.name || '',
              ref: worktree.ref || '',
              issue_url: worktree.issue_url || '',
              pull_request_url: worktree.pull_request_url || '',
              notes: worktree.notes || '',
              path: worktree.path || '',
              context: worktree.custom_context || {},
            }
          : {
              name: '',
              ref: '',
              issue_url: '',
              pull_request_url: '',
              notes: '',
              path: '',
              context: {},
            },
        board: {
          name: boardName || '',
          description: boardDescription || '',
          context: boardCustomContext || {},
        },
        session:
          mode === 'reuse_existing' && selectedSessionId
            ? {
                description:
                  worktreeSessions.find(s => s.session_id === selectedSessionId)?.description || '',
                context:
                  worktreeSessions.find(s => s.session_id === selectedSessionId)?.custom_context ||
                  {},
              }
            : {
                description: '',
                context: {},
              },
      };

      const template = Handlebars.compile(trigger.template);
      return template(context);
    } catch (error) {
      console.error('Handlebars template error:', error);
      return trigger.template; // Fallback to raw template
    }
  }, [
    trigger.template,
    worktree,
    boardName,
    boardDescription,
    boardCustomContext,
    mode,
    selectedSessionId,
    worktreeSessions,
  ]);

  // Update editable template when rendered template changes
  useEffect(() => {
    setEditableTemplate(renderedTemplate);
  }, [renderedTemplate]);

  const handleExecute = async () => {
    if (mode === 'create_new') {
      // Use component state which is guaranteed to have the correct values
      // regardless of whether the form fields are mounted/visible
      await onExecute({
        sessionId: 'new',
        action: 'prompt',
        renderedTemplate: editableTemplate,
        agent: selectedAgent,
        modelConfig: sessionConfig.modelConfig,
        permissionMode: sessionConfig.permissionMode,
        mcpServerIds: sessionConfig.mcpServerIds,
      });
    } else {
      // Reuse existing session
      const formValues = form.getFieldsValue();

      // For 'prompt' action on reuse: just send the prompt (form shows current config for reference)
      // For 'fork'/'spawn': include agent config (will be used in future backend updates)
      const params: Parameters<typeof onExecute>[0] = {
        sessionId: selectedSessionId,
        action: selectedAction,
        renderedTemplate: editableTemplate,
      };

      if (selectedAction === 'fork' || selectedAction === 'spawn') {
        // Include config for fork/spawn (eventual support for changing config)
        params.agent = formValues.agent || selectedSession?.agentic_tool;
        params.modelConfig = formValues.modelConfig;
        params.permissionMode = formValues.permissionMode;
        params.mcpServerIds = formValues.mcpServerIds;
      }

      await onExecute(params);
    }
  };

  return (
    <Modal
      title={`Zone Trigger: ${zoneName}`}
      open={open}
      onCancel={onCancel}
      onOk={handleExecute}
      okText="Execute Trigger"
      cancelText="Cancel"
      width={700}
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* Primary Choice: Create New or Reuse */}
        <div>
          <Radio.Group
            value={mode}
            onChange={e => setMode(e.target.value)}
            style={{ width: '100%' }}
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Radio value="create_new">Create a new session</Radio>
              <Radio value="reuse_existing" disabled={worktreeSessions.length === 0}>
                Reuse a session
              </Radio>
            </Space>
          </Radio.Group>
          {worktreeSessions.length === 0 && (
            <Alert
              message="No existing sessions in this worktree"
              type="info"
              showIcon
              style={{ marginTop: 12 }}
            />
          )}
        </div>

        {/* Session & Action Selection (only for reuse mode) */}
        {mode === 'reuse_existing' && (
          <Form form={form} layout="vertical">
            <div>
              <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                Select Session
              </Typography.Text>
              <Select
                value={selectedSessionId}
                onChange={setSelectedSessionId}
                style={{ width: '100%' }}
                size="large"
                options={worktreeSessions.map(session => ({
                  value: session.session_id,
                  label: (
                    <span>
                      {session.title || session.description || session.session_id.substring(0, 8)} (
                      {session.status})
                    </span>
                  ),
                }))}
              />
            </div>

            <div style={{ marginTop: 24 }}>
              <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                Choose Action
              </Typography.Text>
              <Radio.Group
                value={selectedAction}
                onChange={e => setSelectedAction(e.target.value)}
                style={{ width: '100%' }}
              >
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Radio value="prompt">Prompt - Send message to selected session</Radio>
                  <Radio value="fork">Fork - Fork selected session and send message</Radio>
                  <Radio value="spawn">Spawn - Spawn child session and send message</Radio>
                </Space>
              </Radio.Group>
            </div>
          </Form>
        )}

        {/* Agent Configuration - Always shown (collapsed for reuse, expanded for create_new) */}
        <Form
          form={form}
          layout="vertical"
          onValuesChange={changedValues => {
            // Sync form changes to component state (only in create_new mode)
            if (mode === 'create_new') {
              setSessionConfig(prev => ({ ...prev, ...changedValues }));
            }
          }}
        >
          {mode === 'create_new' && (
            <div>
              <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                Select Agent
              </Typography.Text>
              <AgentSelectionGrid
                agents={availableAgents}
                selectedAgentId={selectedAgent}
                onSelect={setSelectedAgent}
                columns={2}
                showHelperText={false}
                showComparisonLink={false}
              />
            </div>
          )}

          <Collapse
            ghost
            defaultActiveKey={[]}
            expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
            items={[
              {
                key: 'agentic-tool-config',
                label: (
                  <Typography.Text strong>
                    {mode === 'create_new'
                      ? 'Agentic Tool Configuration (optional)'
                      : `Session Configuration (${selectedSession?.agentic_tool || 'unknown'})`}
                  </Typography.Text>
                ),
                children: (
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    {mode === 'reuse_existing' && (
                      <Alert
                        message="Showing current configuration. These settings are for reference."
                        type="info"
                        showIcon
                      />
                    )}
                    <AgenticToolConfigForm
                      agenticTool={
                        (mode === 'create_new'
                          ? (selectedAgent as AgenticToolName)
                          : (selectedSession?.agentic_tool as AgenticToolName)) || 'claude-code'
                      }
                      mcpServers={mcpServers}
                      showHelpText={true}
                    />
                  </Space>
                ),
              },
            ]}
            style={{ marginTop: 16 }}
          />
        </Form>

        {/* Editable Template */}
        <div>
          <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
            Prompt (editable)
          </Typography.Text>
          <Input.TextArea
            value={editableTemplate}
            onChange={e => setEditableTemplate(e.target.value)}
            rows={8}
            style={{
              fontFamily: 'monospace',
              fontSize: '13px',
              lineHeight: '1.5',
            }}
            placeholder="Edit the rendered prompt before executing..."
          />
        </div>
      </Space>
    </Modal>
  );
};
