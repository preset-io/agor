/**
 * Session Settings Modal
 *
 * Redesigned with progressive disclosure:
 *
 * PRIMARY ZONE (always visible, no section wrappers):
 *   - Title
 *   - Model selector
 *   - Permission mode (compact dropdown)
 *   - MCP servers
 *
 * SECONDARY ZONE (collapsed by default, below divider):
 *   - Codex Settings (only for Codex sessions)
 *   - Callbacks
 *   - Advanced (custom context JSON)
 */

import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  MCPServer,
  PermissionMode,
  Session,
} from '@agor-live/client';
import { DownOutlined, SettingOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { CollapseProps } from 'antd';
import { Collapse, Divider, Form, Modal, Typography } from 'antd';
import React from 'react';
import { AdvancedSettingsForm } from '../AdvancedSettingsForm';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { CallbackConfigForm } from '../CallbackConfigForm';
import { CodexSettingsForm } from '../CodexSettingsForm';
import { SessionMetadataForm } from '../SessionMetadataForm';

export interface SessionSettingsModalProps {
  open: boolean;
  onClose: () => void;
  session: Session;
  mcpServerById: Map<string, MCPServer>;
  sessionMcpServerIds: string[];
  onUpdate?: (sessionId: string, updates: Partial<Session>) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
}

interface FormValues {
  title: string;
  mcpServerIds: string[];
  modelConfig: Session['model_config'];
  permissionMode: PermissionMode;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  codexNetworkAccess: boolean;
  custom_context: string;
  callbackConfig: {
    enabled: boolean;
    includeLastMessage: boolean;
    template?: string;
  };
}

function buildInitialValues(session: Session, sessionMcpServerIds: string[]): FormValues {
  const defaultPermissionMode: PermissionMode =
    session.agentic_tool === 'codex'
      ? 'auto'
      : session.agentic_tool === 'gemini' || session.agentic_tool === 'opencode'
        ? 'autoEdit'
        : 'acceptEdits';

  return {
    title: session.title || '',
    mcpServerIds: sessionMcpServerIds,
    modelConfig: session.model_config,
    permissionMode: session.permission_config?.mode || defaultPermissionMode,
    codexSandboxMode: session.permission_config?.codex?.sandboxMode || 'workspace-write',
    codexApprovalPolicy: session.permission_config?.codex?.approvalPolicy || 'on-request',
    codexNetworkAccess: session.permission_config?.codex?.networkAccess ?? false,
    custom_context: session.custom_context ? JSON.stringify(session.custom_context, null, 2) : '',
    callbackConfig: {
      enabled: session.callback_config?.enabled ?? true,
      includeLastMessage: session.callback_config?.include_last_message ?? true,
      template: session.callback_config?.template,
    },
  };
}

function buildUpdates(values: FormValues, session: Session): Partial<Session> {
  const updates: Partial<Session> = {};

  if (values.title !== session.title) {
    updates.title = values.title;
  }

  if (values.modelConfig) {
    updates.model_config = {
      ...values.modelConfig,
      updated_at: new Date().toISOString(),
    };
  }

  if (values.permissionMode) {
    updates.permission_config = {
      ...session.permission_config,
      mode: values.permissionMode,
    };
  }

  if (session.agentic_tool === 'codex') {
    updates.permission_config = {
      ...session.permission_config,
      ...updates.permission_config,
      codex: {
        sandboxMode:
          values.codexSandboxMode ||
          session.permission_config?.codex?.sandboxMode ||
          'workspace-write',
        approvalPolicy:
          values.codexApprovalPolicy ||
          session.permission_config?.codex?.approvalPolicy ||
          'on-request',
        networkAccess:
          values.codexNetworkAccess ?? session.permission_config?.codex?.networkAccess ?? false,
      },
    };
  }

  if (values.custom_context) {
    try {
      updates.custom_context = JSON.parse(values.custom_context);
    } catch {
      // Don't update if JSON is invalid
    }
  } else if (values.custom_context === '') {
    updates.custom_context = undefined;
  }

  if (values.callbackConfig) {
    updates.callback_config = {
      enabled: values.callbackConfig.enabled ?? true,
      include_last_message: values.callbackConfig.includeLastMessage ?? true,
      template: values.callbackConfig.template || undefined,
    };
  }

  return updates;
}

export const SessionSettingsModal: React.FC<SessionSettingsModalProps> = ({
  open,
  onClose,
  session,
  mcpServerById,
  sessionMcpServerIds,
  onUpdate,
  onUpdateSessionMcpServers,
}) => {
  const [form] = Form.useForm();
  const [initialValues, setInitialValues] = React.useState<FormValues>(() =>
    buildInitialValues(session, sessionMcpServerIds)
  );
  const prevOpenRef = React.useRef(false);
  const prevSessionIdRef = React.useRef(session.session_id);

  // Reset form when modal opens OR when session changes while open (retargeting)
  React.useEffect(() => {
    const wasOpen = prevOpenRef.current;
    const sessionChanged = session.session_id !== prevSessionIdRef.current;
    prevOpenRef.current = open;
    prevSessionIdRef.current = session.session_id;

    if ((open && !wasOpen) || (open && sessionChanged)) {
      const values = buildInitialValues(session, sessionMcpServerIds);
      setInitialValues(values);
      form.setFieldsValue(values);
    }
  }, [open, session, sessionMcpServerIds, form]);

  const handleOk = () => {
    form.validateFields().then(() => {
      // Use getFieldsValue(true) to include values from collapsed panels
      const values = form.getFieldsValue(true) as FormValues;
      const updates = buildUpdates(values, session);

      if (Object.keys(updates).length > 0 && onUpdate) {
        onUpdate(session.session_id, updates);
      }

      if (onUpdateSessionMcpServers) {
        onUpdateSessionMcpServers(session.session_id, values.mcpServerIds || []);
      }

      onClose();
    });
  };

  const handleCancel = () => {
    form.resetFields();
    onClose();
  };

  const isCodex = session.agentic_tool === 'codex';

  // Build secondary (collapsed) sections
  const secondaryItems: NonNullable<CollapseProps['items']> = [];

  if (isCodex) {
    secondaryItems.push({
      key: 'codex-settings',
      label: (
        <Typography.Text strong>
          <SettingOutlined style={{ marginRight: 8 }} />
          Codex Sandbox & Policies
        </Typography.Text>
      ),
      children: <CodexSettingsForm showHelpText />,
    });
  }

  secondaryItems.push({
    key: 'callback-config',
    label: (
      <Typography.Text strong>
        <ThunderboltOutlined style={{ marginRight: 8 }} />
        Callbacks
      </Typography.Text>
    ),
    children: <CallbackConfigForm showHelpText />,
  });

  secondaryItems.push({
    key: 'advanced',
    label: (
      <Typography.Text strong>
        <SettingOutlined style={{ marginRight: 8 }} />
        Advanced
      </Typography.Text>
    ),
    children: <AdvancedSettingsForm showHelpText />,
  });

  return (
    <Modal
      title="Session Settings"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="Save"
      cancelText="Cancel"
      width={600}
    >
      <Form form={form} layout="vertical" initialValues={initialValues}>
        {/* PRIMARY ZONE — essential settings, always visible */}
        <SessionMetadataForm showHelpText={false} titleRequired={false} titleLabel="Title" />
        <AgenticToolConfigForm
          agenticTool={session.agentic_tool}
          mcpServerById={mcpServerById}
          showHelpText={false}
          compact
        />

        {/* SECONDARY ZONE — niche settings, collapsed by default */}
        <Divider dashed style={{ margin: '8px 0 16px' }} />
        <Collapse
          ghost
          destroyOnHidden={false}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={secondaryItems}
        />
      </Form>
    </Modal>
  );
};
