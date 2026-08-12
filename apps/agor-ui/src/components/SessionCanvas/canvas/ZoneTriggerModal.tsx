/**
 * Modal for handling zone triggers on branch drops
 * Flow:
 * 1. Primary choice: Create new session OR Reuse existing session
 * 2. If reuse: Select session and choose action (Prompt/Fork/Spawn)
 */

import type {
  AgenticToolName,
  AgorClient,
  Branch,
  DefaultModelConfig,
  EffortLevel,
  MCPServer,
  PermissionMode,
  Session,
  User,
  ZoneTrigger,
} from '@agor-live/client';
// Canonical zone-trigger context shape (branch.context / board.context /
// zone / session). Shared with the daemon's fire-zone-trigger route and the
// MCP `agor_branches_set_zone` path so all three render against the same
// shape.
import { buildZoneTriggerContext, isAgenticToolName } from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import { Alert, Collapse, Form, Input, Modal, Radio, Select, Space, Spin, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgenticToolOption } from '../../../types';
import { getSessionDisplayTitle } from '../../../utils/sessionTitle';
// Async server-side renderer — keeps Handlebars out of the browser bundle so
// the page doesn't need CSP `script-src 'unsafe-eval'`.
import { renderTemplate } from '../../../utils/templates';
import { AgenticToolConfigForm, buildModelConfigFromFormValues } from '../../AgenticToolConfigForm';
import {
  AgenticToolConfigurationPicker,
  INLINE_AGENTIC_CONFIGURATION,
} from '../../AgenticToolConfigurationPicker';
import { AgentSelectionGrid } from '../../AgentSelectionGrid';

interface ZoneTriggerModalProps {
  /** Stable for one drop action; changes only when a new trigger action opens. */
  actionId: number;
  open: boolean;
  onCancel: () => void;
  client: AgorClient | null;
  branch: Branch | undefined;
  sessions: readonly Session[];
  zoneName: string;
  trigger: ZoneTrigger;
  boardName?: string;
  boardDescription?: string;
  boardCustomContext?: Record<string, unknown>;
  availableAgents: AgenticToolOption[];
  mcpServerById: Map<string, MCPServer>;
  currentUser?: User | null; // Optional - current user for default settings
  onExecute: (params: {
    sessionId: string | 'new';
    action: 'prompt' | 'fork' | 'spawn';
    renderedTemplate: string;
    // New session config (only when sessionId === 'new')
    agent?: string;
    agenticToolPresetId?: string;
    modelConfig?: DefaultModelConfig;
    permissionMode?: PermissionMode;
    mcpServerIds?: string[];
  }) => Promise<void>;
}

const ZoneTriggerModalAction = ({
  open,
  onCancel,
  client,
  branch,
  sessions,
  zoneName,
  trigger,
  boardName,
  boardDescription,
  boardCustomContext,
  availableAgents,
  mcpServerById,
  currentUser,
  onExecute,
}: ZoneTriggerModalProps) => {
  const [form] = Form.useForm();

  // A zone-trigger action is an editing transaction. Snapshot every value
  // that supplies defaults or template context at its boundary so realtime
  // store updates cannot silently restart that transaction. The exported
  // boundary below remounts this component for each new actionId.
  const [initial] = useState(() => {
    const branchSessions = sessions.filter(
      (session): session is Session & { agentic_tool: AgenticToolName } =>
        isAgenticToolName(session.agentic_tool)
    );
    const runningSessions = branchSessions.filter((session) => session.status === 'running');
    const defaultSession = [
      ...(runningSessions.length > 0 ? runningSessions : branchSessions),
    ].sort(
      (a, b) =>
        new Date(b.last_updated || b.created_at).getTime() -
        new Date(a.last_updated || a.created_at).getTime()
    )[0]?.session_id;
    const mode = branchSessions.length > 0 ? ('reuse_existing' as const) : ('create_new' as const);

    return {
      client,
      branch,
      branchSessions,
      zoneName,
      trigger: { ...trigger },
      boardName,
      boardDescription,
      boardCustomContext,
      currentUser,
      mode,
      selectedSessionId: defaultSession || '',
      selectedAgent:
        trigger.agent === undefined
          ? ('claude-code' as const)
          : isAgenticToolName(trigger.agent)
            ? trigger.agent
            : null,
    };
  });
  const branchSessions = initial.branchSessions;

  // Primary mode: create new or reuse existing
  const [mode, setMode] = useState<'create_new' | 'reuse_existing'>(initial.mode);

  // Agent selection (only for create_new mode)
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName | null>(initial.selectedAgent);
  const requiresSupportedToolSelection =
    mode === 'create_new' && selectedAgent === null && initial.trigger.agent !== undefined;

  // Session selection (only for reuse mode)
  const [selectedSessionId, setSelectedSessionId] = useState<string>(initial.selectedSessionId);

  // Action selection (only for reuse mode)
  const [selectedAction, setSelectedAction] = useState<'prompt' | 'fork' | 'spawn'>('prompt');

  const initialTemplateTarget =
    initial.mode === 'reuse_existing' ? `session:${initial.selectedSessionId}` : 'new';
  const [templateState, setTemplateState] = useState({
    target: initialTemplateTarget,
    value: initial.client ? '' : initial.trigger.template,
    isRendering: Boolean(initial.client),
  });
  const templateEditRevisionRef = useRef(0);
  const templateRenderRequestRef = useRef<{
    target: string;
    editRevision: number;
    promise: Promise<string>;
  } | null>(null);

  // Explicit state for session config (survives form mount/unmount cycles)
  const [sessionConfig, setSessionConfig] = useState<{
    agenticToolPresetId?: string;
    modelConfig?: DefaultModelConfig;
    effort?: EffortLevel;
    permissionMode?: PermissionMode;
    mcpServerIds?: string[];
  }>({});

  // Get the currently selected session (for pre-populating form on reuse)
  const selectedSession = useMemo(() => {
    return branchSessions.find((s) => s.session_id === selectedSessionId);
  }, [selectedSessionId, branchSessions]);

  // Pre-populate form AND state when creating new session
  // Priority: Most recent session > User defaults > System defaults
  const formInitializationRef = useRef<string | null>(null);
  useEffect(() => {
    if (mode === 'create_new' && selectedAgent) {
      const initializationKey = `new:${selectedAgent}`;
      if (formInitializationRef.current === initializationKey) return;
      formInitializationRef.current = initializationKey;

      // Find the most recent session for this branch (create a copy to avoid mutating the array)
      const mostRecentSession =
        branchSessions.length > 0
          ? [...branchSessions].sort(
              (a, b) =>
                new Date(b.last_updated || b.created_at).getTime() -
                new Date(a.last_updated || a.created_at).getTime()
            )[0]
          : null;

      // Get user defaults for this agent as fallback
      const agentDefaults =
        initial.currentUser?.default_agentic_config?.[selectedAgent as AgenticToolName];
      const recentAgentSession =
        mostRecentSession?.agentic_tool === selectedAgent ? mostRecentSession : undefined;

      // MCP inheritance: branch config > user defaults
      const effectiveMcpServerIds =
        initial.branch?.mcp_server_ids && initial.branch.mcp_server_ids.length > 0
          ? initial.branch.mcp_server_ids
          : initial.currentUser?.default_mcp_server_ids || [];

      // Calculate config values (priority: most recent session > user defaults)
      const configValues = {
        permissionMode:
          recentAgentSession?.permission_config?.mode || agentDefaults?.permissionMode,
        modelConfig: recentAgentSession?.model_config || agentDefaults?.modelConfig,
        effort: recentAgentSession?.model_config?.effort ?? agentDefaults?.modelConfig?.effort,
        mcpServerIds: form.getFieldValue('mcpServerIds') ?? effectiveMcpServerIds,
      };

      // Store in both form (for UI) AND component state (for execution)
      form.setFieldsValue(configValues);
      setSessionConfig(configValues);
    }
  }, [mode, selectedAgent, initial, branchSessions, form]);

  // Pre-populate form with selected session's config when reusing
  useEffect(() => {
    if (mode === 'reuse_existing' && selectedSession) {
      const initializationKey = `existing:${selectedSession.session_id}`;
      if (formInitializationRef.current === initializationKey) return;
      formInitializationRef.current = initializationKey;

      // Pre-populate with session's current config
      form.setFieldsValue({
        agent: selectedSession.agentic_tool,
        permissionMode: selectedSession.permission_config?.mode,
        modelConfig: selectedSession.model_config,
        effort: selectedSession.model_config?.effort,
        // Note: mcpServerIds would need to be fetched separately if we want to show them
      });
    }
  }, [mode, selectedSession, form]);

  const templateTarget = mode === 'reuse_existing' ? `session:${selectedSessionId}` : 'new';
  const templateStateMatchesTarget = templateState.target === templateTarget;
  const editableTemplate = templateStateMatchesTarget ? templateState.value : '';
  const isRendering = Boolean(
    initial.client && (!templateStateMatchesTarget || templateState.isRendering)
  );

  // Render once for the initial target, and once for each deliberate target
  // change. Reuse an in-flight request when Strict Mode replays the effect.
  useEffect(() => {
    if (!initial.client) {
      setTemplateState((current) => {
        if (
          current.target === templateTarget &&
          current.value === initial.trigger.template &&
          !current.isRendering
        ) {
          return current;
        }
        return { target: templateTarget, value: initial.trigger.template, isRendering: false };
      });
      return;
    }

    const selectedSessionForCtx =
      mode === 'reuse_existing' && selectedSessionId
        ? branchSessions.find((s) => s.session_id === selectedSessionId)
        : undefined;
    const context = buildZoneTriggerContext({
      branch: initial.branch,
      board: {
        name: initial.boardName,
        description: initial.boardDescription,
        custom_context: initial.boardCustomContext,
      },
      zone: { label: initial.zoneName },
      session: selectedSessionForCtx
        ? {
            description: selectedSessionForCtx.description,
            custom_context: selectedSessionForCtx.custom_context,
          }
        : undefined,
    });

    let request = templateRenderRequestRef.current;
    if (!request || request.target !== templateTarget) {
      templateEditRevisionRef.current += 1;
      request = {
        target: templateTarget,
        editRevision: templateEditRevisionRef.current,
        promise: renderTemplate(initial.client, initial.trigger.template, context, 'raw'),
      };
      templateRenderRequestRef.current = request;
      setTemplateState({ target: templateTarget, value: '', isRendering: true });
    }

    let active = true;
    const activeRequest = request;
    void activeRequest.promise.then((rendered) => {
      if (!active || templateRenderRequestRef.current !== activeRequest) return;
      setTemplateState((current) => ({
        target: templateTarget,
        value:
          templateEditRevisionRef.current === activeRequest.editRevision ? rendered : current.value,
        isRendering: false,
      }));
    });
    return () => {
      active = false;
    };
  }, [initial, mode, selectedSessionId, branchSessions, templateTarget]);

  const handleExecute = async () => {
    if (mode === 'create_new') {
      if (!selectedAgent) return;
      // Use component state which is guaranteed to have the correct values
      // regardless of whether the form fields are mounted/visible
      await onExecute({
        sessionId: 'new',
        action: 'prompt',
        renderedTemplate: editableTemplate,
        agent: selectedAgent,
        agenticToolPresetId:
          sessionConfig.agenticToolPresetId === INLINE_AGENTIC_CONFIGURATION
            ? undefined
            : sessionConfig.agenticToolPresetId,
        modelConfig: buildModelConfigFromFormValues(sessionConfig),
        permissionMode: sessionConfig.permissionMode,
        mcpServerIds: sessionConfig.mcpServerIds,
      });
    } else {
      // Reuse existing session
      const formValues = form.getFieldsValue(true);

      // IMPORTANT: Always include permissionMode for all actions
      // The backend executor needs this to override the session's default permission mode
      const params: Parameters<typeof onExecute>[0] = {
        sessionId: selectedSessionId,
        action: selectedAction,
        renderedTemplate: editableTemplate,
        // Use form value, or fallback to session's current mode
        permissionMode: formValues.permissionMode || selectedSession?.permission_config?.mode,
      };

      if (selectedAction === 'fork' || selectedAction === 'spawn') {
        // Include additional config for fork/spawn (eventual support for changing config)
        params.agent = formValues.agent || selectedSession?.agentic_tool;
        params.modelConfig = buildModelConfigFromFormValues({
          modelConfig: formValues.modelConfig,
          effort: formValues.effort,
        });
        params.mcpServerIds = formValues.mcpServerIds;
      }

      await onExecute(params);
    }
  };

  return (
    <Modal
      title={`Zone Trigger: ${initial.zoneName}`}
      open={open}
      onCancel={onCancel}
      onOk={handleExecute}
      okText="Execute Trigger"
      okButtonProps={{ disabled: isRendering || requiresSupportedToolSelection }}
      cancelText="Cancel"
      width={700}
    >
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        {/* Primary Choice: Create New or Reuse */}
        <div>
          <Radio.Group
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            style={{ width: '100%' }}
          >
            <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
              <Radio value="create_new">Create a new session</Radio>
              <Radio value="reuse_existing" disabled={branchSessions.length === 0}>
                Reuse a session
              </Radio>
            </Space>
          </Radio.Group>
          {branchSessions.length === 0 && (
            <Alert
              title="No existing sessions in this branch"
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
                options={branchSessions.map((session) => ({
                  value: session.session_id,
                  label: (
                    <span>
                      {getSessionDisplayTitle(session, {
                        fallbackChars: 50,
                        includeIdFallback: true,
                      })}{' '}
                      ({session.status})
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
                onChange={(e) => setSelectedAction(e.target.value)}
                style={{ width: '100%' }}
              >
                <Space orientation="vertical" style={{ width: '100%' }}>
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
          onValuesChange={(changedValues) => {
            // Sync form changes to component state (only in create_new mode)
            if (mode === 'create_new') {
              setSessionConfig((prev) => ({ ...prev, ...changedValues }));
            }
          }}
        >
          {mode === 'create_new' && (
            <div>
              {requiresSupportedToolSelection && (
                <Alert
                  title="This zone uses a removed agentic tool"
                  description="Choose a supported tool before creating a new session. Existing sessions remain available for reuse."
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                />
              )}
              <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                Select Agent
              </Typography.Text>
              <AgentSelectionGrid
                agents={availableAgents}
                selectedAgentId={selectedAgent}
                onSelect={(agent) => setSelectedAgent(agent as AgenticToolName)}
                columns={2}
                showHelperText={false}
                showComparisonLink={false}
              />
            </div>
          )}

          <Collapse
            ghost
            destroyOnHidden={false}
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
                  <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
                    {mode === 'reuse_existing' && (
                      <Alert
                        title="Showing current configuration. These settings are for reference."
                        type="info"
                        showIcon
                      />
                    )}
                    {mode === 'create_new' && selectedAgent ? (
                      <AgenticToolConfigurationPicker
                        tool={selectedAgent}
                        mcpServerById={mcpServerById}
                        showHelpText={true}
                        client={initial.client}
                      />
                    ) : mode === 'reuse_existing' ? (
                      <AgenticToolConfigForm
                        agenticTool={selectedSession?.agentic_tool || 'claude-code'}
                        showHelpText={true}
                      />
                    ) : null}
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
          <Spin spinning={isRendering} delay={200} description="Rendering template…">
            <Input.TextArea
              value={editableTemplate}
              aria-label="Prompt (editable)"
              onChange={(e) => {
                templateEditRevisionRef.current += 1;
                setTemplateState({
                  target: templateTarget,
                  value: e.target.value,
                  isRendering: false,
                });
              }}
              rows={8}
              style={{
                fontFamily: 'monospace',
                fontSize: '13px',
                lineHeight: '1.5',
              }}
              placeholder="Edit the rendered prompt before executing..."
            />
          </Spin>
        </div>
      </Space>
    </Modal>
  );
};

export const ZoneTriggerModal = (props: ZoneTriggerModalProps) => (
  <ZoneTriggerModalAction key={props.actionId} {...props} />
);
