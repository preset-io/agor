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
  Worktree,
  WorktreeID,
  ZoneTrigger,
} from '@agor/core/types';

// UI-only type for agent selection (different from AgenticTool which has UUIDv7 ID)
interface AgenticToolOption {
  id: string; // AgenticToolName as string
  name: string;
  icon: string;
  installed: boolean;
  installable?: boolean;
  version?: string;
  description?: string;
}

import { DownOutlined } from '@ant-design/icons';
import { Alert, Collapse, Form, Modal, Radio, Select, Space, Typography } from 'antd';
import Handlebars from 'handlebars';
import { useEffect, useMemo, useState } from 'react';
import { AgenticToolConfigForm } from '../../AgenticToolConfigForm';
import { AgentSelectionCard } from '../../AgentSelectionCard';
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

  // Reset to defaults when modal opens
  useEffect(() => {
    if (open) {
      setMode('create_new');
      setSelectedSessionId(smartDefaultSession);
      setSelectedAction('prompt');
    }
  }, [open, smartDefaultSession]);

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

  const handleExecute = async () => {
    if (mode === 'create_new') {
      // Get form values for new session
      const formValues = form.getFieldsValue();
      await onExecute({
        sessionId: 'new',
        action: 'prompt',
        renderedTemplate,
        agent: selectedAgent,
        modelConfig: formValues.modelConfig,
        permissionMode: formValues.permissionMode,
        mcpServerIds: formValues.mcpServerIds,
      });
    } else {
      // Reuse existing session
      const formValues = form.getFieldsValue();
      await onExecute({
        sessionId: selectedSessionId,
        action: selectedAction,
        renderedTemplate,
        // Include agent config for fork/spawn actions
        ...(selectedAction === 'fork' || selectedAction === 'spawn'
          ? {
              agent: selectedAgent,
              modelConfig: formValues.modelConfig,
              permissionMode: formValues.permissionMode,
              mcpServerIds: formValues.mcpServerIds,
            }
          : {}),
      });
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

        {/* Agent Configuration (only for create_new mode) */}
        {mode === 'create_new' && (
          <Form form={form} layout="vertical">
            <div>
              <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                Select Agent
              </Typography.Text>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: 8,
                  marginTop: 8,
                }}
              >
                {availableAgents.map(agent => (
                  <AgentSelectionCard
                    key={agent.id}
                    agent={agent}
                    selected={selectedAgent === agent.id}
                    onClick={() => setSelectedAgent(agent.id)}
                  />
                ))}
              </div>
            </div>

            <Collapse
              ghost
              expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
              items={[
                {
                  key: 'agentic-tool-config',
                  label: <Typography.Text strong>Agentic Tool Configuration</Typography.Text>,
                  children: (
                    <AgenticToolConfigForm
                      agenticTool={(selectedAgent as AgenticToolName) || 'claude-code'}
                      mcpServers={mcpServers}
                      showHelpText={true}
                    />
                  ),
                },
              ]}
              style={{ marginTop: 16 }}
            />
          </Form>
        )}

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

            <div>
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

            {/* Agent selection for fork/spawn */}
            {(selectedAction === 'fork' || selectedAction === 'spawn') && (
              <>
                <div style={{ marginTop: 16 }}>
                  <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                    Select Agent
                  </Typography.Text>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, 1fr)',
                      gap: 8,
                      marginTop: 8,
                    }}
                  >
                    {availableAgents.map(agent => (
                      <AgentSelectionCard
                        key={agent.id}
                        agent={agent}
                        selected={selectedAgent === agent.id}
                        onClick={() => setSelectedAgent(agent.id)}
                      />
                    ))}
                  </div>
                </div>

                <Collapse
                  ghost
                  expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
                  items={[
                    {
                      key: 'agentic-tool-config',
                      label: <Typography.Text strong>Agentic Tool Configuration</Typography.Text>,
                      children: (
                        <AgenticToolConfigForm
                          agenticTool={(selectedAgent as AgenticToolName) || 'claude-code'}
                          mcpServers={mcpServers}
                          showHelpText={true}
                        />
                      ),
                    },
                  ]}
                  style={{ marginTop: 16 }}
                />
              </>
            )}
          </Form>
        )}

        {/* Template Preview */}
        <div>
          <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
            Rendered Prompt
          </Typography.Text>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              background: '#1f1f1f',
              padding: '12px',
              borderRadius: '4px',
              margin: 0,
              fontFamily: 'monospace',
              fontSize: '13px',
              lineHeight: '1.5',
              color: '#d4d4d4',
            }}
          >
            {renderedTemplate}
          </pre>
        </div>
      </Space>
    </Modal>
  );
};
