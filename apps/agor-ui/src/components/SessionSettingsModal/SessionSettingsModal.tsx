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
  AgorClient,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  PermissionMode,
  Session,
  User,
} from '@agor-live/client';
import {
  getDefaultPermissionMode,
  isAgenticToolName,
  mapToCodexPermissionConfig,
} from '@agor-live/client';
import {
  DownOutlined,
  KeyOutlined,
  LoadingOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { CollapseProps } from 'antd';
import { Alert, Button, Collapse, Divider, Form, Modal, Typography, theme } from 'antd';
import React from 'react';
import {
  fullSessionDetailsErrorMessage,
  useFullSessionDetails,
} from '../../hooks/useFullSessionDetails';
import { useSessionMcpServerIds } from '../../hooks/useSessionMcpServerIds';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById } from '../../store/selectors';
import { useThemedMessage } from '../../utils/message';
import { AdvancedSettingsForm } from '../AdvancedSettingsForm';
import { AgenticConfigChipRow } from '../AgenticConfigChipRow';
import type { AgenticFormValues } from '../AgenticToolConfigForm';
import { buildModelConfigFromFormValues } from '../AgenticToolConfigForm';
import {
  INLINE_AGENTIC_CONFIGURATION,
  persistUserDefaultFromForm,
} from '../AgenticToolConfigurationPicker';
import { CallbackConfigForm } from '../CallbackConfigForm';
import { CallbackTargetDisplay } from '../CallbackToggleButton';
import { CodexSettingsForm } from '../CodexSettingsForm';
import { ErrorBoundary } from '../ErrorBoundary';
import { SessionEnvVarsSelector } from '../SessionEnvVarsSelector';
import { SessionIdsList } from '../SessionIds';
import { SessionMetadataForm } from '../SessionMetadataForm';
import { buildCustomContextPatch, jsonEqual } from './customContextPatch';

export interface SessionSettingsModalProps {
  open: boolean;
  onClose: () => void;
  session: Session;
  onUpdate?: (sessionId: string, updates: Partial<Session>) => void;
  onUpdateSessionMcpServers?: (
    sessionId: string,
    mcpServerIds: string[],
    /** The links the user was shown; the change is diffed against them. */
    baselineIds?: string[]
  ) => void;
  /**
   * Called on save with the new list of env var names the session creator has
   * selected to export into the session's executor process. Only the session's
   * creator or an admin can edit these. The Environment Variables section is
   * rendered only when this is wired, so an edit can never be silently dropped.
   */
  onUpdateSessionEnvSelections?: (sessionId: string, envVarNames: string[]) => void;
  /** Client for loading current env selections and the creator's env var list. */
  client?: AgorClient | null;
  /** The user currently viewing the modal (for RBAC gating of env selections). */
  currentUser?: User | null;
}

interface FormValues {
  agenticToolPresetId: string;
  title: string;
  mcpServerIds: string[];
  modelConfig: Session['model_config'];
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  codexNetworkAccess: boolean;
  saveAsDefault?: boolean;
  custom_context: string;
  callbackConfig: {
    enabled: boolean;
    includeLastMessage: boolean;
    template?: string;
  };
}

function formatCustomContext(customContext: Session['custom_context']): string {
  return customContext ? JSON.stringify(customContext, null, 2) : '';
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function buildInitialValues(session: Session, sessionMcpServerIds: string[]): FormValues {
  const permissionMode: PermissionMode =
    session.permission_config?.mode ??
    (isAgenticToolName(session.agentic_tool)
      ? getDefaultPermissionMode(session.agentic_tool)
      : 'default');
  const codexDefaults = mapToCodexPermissionConfig(permissionMode);

  return {
    agenticToolPresetId: session.agentic_tool_preset_id ?? INLINE_AGENTIC_CONFIGURATION,
    title: session.title || '',
    mcpServerIds: sessionMcpServerIds,
    modelConfig: session.model_config,
    // Effort is surfaced as its own form field (the effort chip binds to it),
    // then folded back into model_config on save.
    effort: session.model_config?.effort,
    permissionMode,
    codexSandboxMode: session.permission_config?.codex?.sandboxMode ?? codexDefaults.sandboxMode,
    codexApprovalPolicy:
      session.permission_config?.codex?.approvalPolicy ?? codexDefaults.approvalPolicy,
    codexNetworkAccess:
      session.permission_config?.codex?.networkAccess ?? codexDefaults.networkAccess,
    saveAsDefault: false,
    custom_context: formatCustomContext(session.custom_context),
    callbackConfig: {
      enabled: session.callback_config?.enabled ?? true,
      includeLastMessage: session.callback_config?.include_last_message ?? true,
      template: session.callback_config?.template,
    },
  };
}

/** Model config as the form folds it, without the server-stamped `updated_at`. */
function comparableModelConfig(values: Pick<FormValues, 'modelConfig' | 'effort'>) {
  const modelConfig = buildModelConfigFromFormValues({
    modelConfig: values.modelConfig ?? undefined,
    effort: values.effort,
  });
  if (!modelConfig) return undefined;
  const { updated_at: _updatedAt, ...rest } = modelConfig as typeof modelConfig & {
    updated_at?: string;
  };
  return rest;
}

function buildUpdates(values: FormValues, session: Session, initial: FormValues): Partial<Session> {
  const initialCustomContext = initial.custom_context;
  const updates: Partial<Session> = {};

  if (values.title !== session.title) {
    updates.title = values.title;
  }

  const presetId =
    values.agenticToolPresetId === INLINE_AGENTIC_CONFIGURATION ? null : values.agenticToolPresetId;
  if (presetId !== (session.agentic_tool_preset_id ?? null)) {
    updates.agentic_tool_preset_id = presetId as Session['agentic_tool_preset_id'];
  }

  // Only send model_config when the model or effort was changed from what the
  // form was seeded with; the daemon keeps the stored value otherwise.
  if (
    !presetId &&
    values.modelConfig &&
    !jsonEqual(comparableModelConfig(values), comparableModelConfig(initial))
  ) {
    const modelConfig = buildModelConfigFromFormValues({
      modelConfig: values.modelConfig,
      effort: values.effort,
    });
    updates.model_config = {
      ...modelConfig,
      updated_at: new Date().toISOString(),
    } as NonNullable<Session['model_config']>;
  }

  if (!presetId && values.permissionMode) {
    updates.permission_config = {
      ...session.permission_config,
      mode: values.permissionMode,
    };
  }

  if (!presetId && session.agentic_tool === 'codex') {
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

  // Only send custom_context when the JSON was actually edited, and then only
  // the top-level keys that changed relative to the snapshot the editor was
  // seeded with: echoing unchanged values would overwrite newer server-side
  // ones (arrays such as SDK-reported slash_commands replace on patch).
  if (values.custom_context !== initialCustomContext) {
    if (values.custom_context) {
      try {
        const patch = buildCustomContextPatch(
          initialCustomContext ? JSON.parse(initialCustomContext) : {},
          JSON.parse(values.custom_context)
        );
        if (patch !== undefined) updates.custom_context = patch;
      } catch {
        // Don't update if JSON is invalid
      }
    } else if (values.custom_context === '') {
      updates.custom_context = undefined;
    }
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
  onUpdate,
  onUpdateSessionMcpServers,
  onUpdateSessionEnvSelections,
  client,
  currentUser,
}) => {
  const activeAgenticTool = isAgenticToolName(session.agentic_tool) ? session.agentic_tool : null;
  // Entity maps come from the store rather than being drilled through the App
  // shell. The whole session→MCP map is sliced to this session's ids here so
  // the rest of the component keeps working with a plain `string[]`.
  const { showError } = useThemedMessage();
  const { token } = theme.useToken();
  const mcpServerById = useAgorStore(selectMcpServerById);
  // Loaded on first need. Until then the ids may be partial, so the MCP chip
  // is read-only and saving never sends an MCP diff (it would detach links
  // the form never held).
  const { ids: sessionMcpServerIds, loaded: sessionMcpLoaded } = useSessionMcpServerIds(
    client,
    session.session_id
  );
  const [form] = Form.useForm();
  const watchedPresetId = Form.useWatch('agenticToolPresetId', form) as string | undefined;
  const isInlineConfig = watchedPresetId === INLINE_AGENTIC_CONFIGURATION;

  // The `session` prop may be a lean list row that withholds bulky
  // custom_context keys. Seed the editable JSON from the full record so the
  // user edits what is actually stored; read-only until it has loaded, and a
  // visible error + Retry (never the lean row) if it cannot.
  const fullDetails = useFullSessionDetails(client, session, open);
  const fullSession = fullDetails.status === 'ready' ? fullDetails.session : null;
  const [initialValues, setInitialValues] = React.useState<FormValues>(() =>
    buildInitialValues(fullSession ?? session, sessionMcpServerIds)
  );
  const initialValuesRef = React.useRef(initialValues);
  initialValuesRef.current = initialValues;
  // The full record whose context the field currently holds. The editor
  // unlocks only once the field is seeded, never on the render the record
  // arrives in (the seed effect runs after that commit).
  const [seededFullSession, setSeededFullSession] = React.useState<Session | null>(null);
  const seededFullSessionRef = React.useRef(seededFullSession);
  const customContextReady = fullSession !== null && seededFullSession === fullSession;
  const [envSelections, setEnvSelections] = React.useState<string[]>([]);
  const [initialEnvSelections, setInitialEnvSelections] = React.useState<string[]>([]);
  const prevOpenRef = React.useRef(false);
  const prevSessionIdRef = React.useRef(session.session_id);

  // Only the session's creator or a global admin can edit env selections.
  // Branch `all` permission does NOT grant access.
  const canEditEnvSelections = React.useMemo(() => {
    if (!currentUser) return false;
    if (currentUser.user_id === session.created_by) return true;
    const role = currentUser.role as string | undefined;
    return role === 'admin' || role === 'superadmin';
  }, [currentUser, session.created_by]);

  // Reset form when modal opens OR when session changes while open (retargeting)
  React.useEffect(() => {
    const wasOpen = prevOpenRef.current;
    const sessionChanged = session.session_id !== prevSessionIdRef.current;
    prevOpenRef.current = open;
    prevSessionIdRef.current = session.session_id;

    if ((open && !wasOpen) || (open && sessionChanged)) {
      const values = buildInitialValues(session, sessionMcpServerIds);
      if (fullSession?.session_id === session.session_id) {
        values.custom_context = formatCustomContext(fullSession.custom_context);
        seededFullSessionRef.current = fullSession;
        setSeededFullSession(fullSession);
      }
      setInitialValues(values);
      form.setFieldsValue(values);
    }
  }, [open, session, sessionMcpServerIds, form, fullSession]);

  // The MCP selection the user was shown, seeded from this session's loaded
  // links. While the field still equals it, a reload (e.g. after a
  // reconnect) reseeds both; an edit is kept, and so is the baseline it was
  // made against. Save sends an MCP change only for an edit, diffed against
  // this baseline, so links the user never saw are never detached.
  const mcpBaselineRef = React.useRef<{ sessionId: string; ids: string[] } | null>(null);
  React.useEffect(() => {
    if (!open) {
      mcpBaselineRef.current = null;
      return;
    }
    if (!sessionMcpLoaded) return;
    const baseline = mcpBaselineRef.current;
    if (baseline?.sessionId === session.session_id) {
      if (sameIds(baseline.ids, sessionMcpServerIds)) return;
      const field = (form.getFieldValue('mcpServerIds') as string[] | undefined) ?? [];
      if (!sameIds(field, baseline.ids)) return; // edited: keep the edit and its baseline
    }
    mcpBaselineRef.current = { sessionId: session.session_id, ids: sessionMcpServerIds };
    setInitialValues((previous) => ({ ...previous, mcpServerIds: sessionMcpServerIds }));
    form.setFieldValue('mcpServerIds', sessionMcpServerIds);
  }, [open, sessionMcpLoaded, sessionMcpServerIds, session.session_id, form]);

  // Seed custom_context once the full record arrives (on open, retarget,
  // Retry, or a reconnect retry). The field is read-only until then; an
  // unedited field is replaced, an edit in progress is kept.
  React.useEffect(() => {
    if (!open || !fullSession || fullSession.session_id !== session.session_id) return;
    if (seededFullSessionRef.current === fullSession) return;
    seededFullSessionRef.current = fullSession;
    const text = formatCustomContext(fullSession.custom_context);
    const unedited =
      form.getFieldValue('custom_context') === initialValuesRef.current.custom_context;
    setInitialValues((previous) => ({ ...previous, custom_context: text }));
    if (unedited) form.setFieldValue('custom_context', text);
    setSeededFullSession(fullSession);
  }, [open, fullSession, session.session_id, form]);

  // Load current env selections when the modal opens.
  React.useEffect(() => {
    if (!open || !client || !canEditEnvSelections) return;
    let cancelled = false;
    (async () => {
      try {
        // GET /sessions/:id/env-selections returns the selected names as
        // `string[]` (see register-routes.ts — matches the route comment
        // "list selected env var names").
        const names = (await client
          .service(`sessions/${session.session_id}/env-selections`)
          .find()) as string[];
        if (!cancelled) {
          setEnvSelections(names);
          setInitialEnvSelections(names);
        }
      } catch {
        // Non-fatal; leave list empty. User can still make a selection and save.
        if (!cancelled) {
          setEnvSelections([]);
          setInitialEnvSelections([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, client, canEditEnvSelections, session.session_id]);

  const handleOk = () => {
    if (!activeAgenticTool) {
      onClose();
      return;
    }
    form.validateFields().then(() => {
      // Use getFieldsValue(true) to include values from collapsed panels
      const values = form.getFieldsValue(true) as FormValues;
      const updates = buildUpdates(values, session, initialValues);

      if (Object.keys(updates).length > 0 && onUpdate) {
        onUpdate(session.session_id, updates);
      }

      // Promote the inline config to the user's default when requested.
      if (
        values.saveAsDefault &&
        values.agenticToolPresetId === INLINE_AGENTIC_CONFIGURATION &&
        currentUser &&
        client
      ) {
        const formValues: AgenticFormValues = {
          modelConfig: values.modelConfig ?? undefined,
          effort: values.effort,
          permissionMode: values.permissionMode,
          codexSandboxMode: values.codexSandboxMode,
          codexApprovalPolicy: values.codexApprovalPolicy,
          codexNetworkAccess: values.codexNetworkAccess,
        };
        void persistUserDefaultFromForm(client, currentUser, activeAgenticTool, formValues).catch(
          () => showError('Failed to save your default configuration')
        );
      }

      const mcpBaseline = mcpBaselineRef.current;
      const nextMcpServerIds = values.mcpServerIds || [];
      if (
        onUpdateSessionMcpServers &&
        mcpBaseline?.sessionId === session.session_id &&
        !sameIds(nextMcpServerIds, mcpBaseline.ids)
      ) {
        onUpdateSessionMcpServers(session.session_id, nextMcpServerIds, mcpBaseline.ids);
      }

      if (canEditEnvSelections && onUpdateSessionEnvSelections) {
        const changed =
          envSelections.length !== initialEnvSelections.length ||
          envSelections.some((n) => !initialEnvSelections.includes(n));
        if (changed) {
          onUpdateSessionEnvSelections(session.session_id, envSelections);
        }
      }

      form.setFieldValue('saveAsDefault', false);
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

  if (isCodex && isInlineConfig) {
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

  if (canEditEnvSelections && client && onUpdateSessionEnvSelections) {
    secondaryItems.push({
      key: 'env-selections',
      label: (
        <Typography.Text strong>
          <KeyOutlined style={{ marginRight: 8 }} />
          Environment Variables
        </Typography.Text>
      ),
      children: (
        <SessionEnvVarsSelector
          ownerUserId={session.created_by as import('@agor-live/client').UserID}
          client={client}
          value={envSelections}
          onChange={setEnvSelections}
        />
      ),
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
    children: (
      <>
        <CallbackTargetDisplay session={session} onNavigate={onClose} />
        <CallbackConfigForm showHelpText />
      </>
    ),
  });

  secondaryItems.push({
    key: 'advanced',
    label: (
      <>
        <Typography.Text strong>
          <SettingOutlined style={{ marginRight: 8 }} />
          Advanced
        </Typography.Text>
        {fullDetails.status === 'error' && (
          <Typography.Text type="danger" style={{ marginLeft: token.marginXS }}>
            (details unavailable)
          </Typography.Text>
        )}
        {fullDetails.status === 'loading' && (
          <Typography.Text type="secondary" style={{ marginLeft: token.marginXS }}>
            <LoadingOutlined style={{ marginRight: token.marginXXS }} />
            (loading…)
          </Typography.Text>
        )}
      </>
    ),
    children: (
      <ErrorBoundary
        fallbackTitle="Failed to load Advanced settings."
        resetKey={session.session_id}
      >
        {fullDetails.status === 'error' && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: token.marginSM }}
            title={fullSessionDetailsErrorMessage(fullDetails.error)}
            description="Custom context stays read-only: this view omits scheduled-run and SDK command/skill fields until the full record loads."
            action={
              <Button size="small" onClick={fullDetails.retry}>
                Retry
              </Button>
            }
          />
        )}
        {/* The read-only editor below still holds the lean row's context, which
            looks complete; say plainly that it is not. */}
        {fullDetails.status === 'loading' && (
          <Alert
            type="info"
            showIcon
            icon={<LoadingOutlined />}
            style={{ marginBottom: token.marginSM }}
            title="Loading full session context…"
            description="Custom context is read-only until it loads. Scheduled-run and SDK command/skill fields are not shown yet."
          />
        )}
        <AdvancedSettingsForm showHelpText disabled={!customContextReady} />
      </ErrorBoundary>
    ),
  });

  if (!activeAgenticTool) {
    return (
      <Modal title="Historical Session" open={open} onCancel={onClose} footer={null} width={600}>
        <Typography.Paragraph>
          This session used the removed experimental Claude Code CLI integration. Its stored
          metadata and conversation remain readable, but its runtime settings cannot be changed and
          the session cannot be resumed.
        </Typography.Paragraph>
        <SessionIdsList session={session} />
      </Modal>
    );
  }

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
      <Form
        form={form}
        layout="vertical"
        initialValues={initialValues}
        // Suffix-style required mark ("Label *"), matching NewSessionModal.
        requiredMark={(label, { required }) => (
          <>
            {label}
            {required && (
              <span style={{ color: token.colorError, marginInlineStart: token.marginXXS }}>*</span>
            )}
          </>
        )}
      >
        {/* PRIMARY ZONE — essential settings, always visible */}
        <SessionMetadataForm showHelpText={false} titleRequired={false} titleLabel="Title" />
        <Form.Item label="Session IDs">
          <SessionIdsList session={session} />
        </Form.Item>
        {/* Configuration source Select + resolved chips — parity with NewSessionModal */}
        <AgenticConfigChipRow
          tool={activeAgenticTool}
          mcpServerById={mcpServerById}
          currentUser={currentUser}
          client={client ?? null}
          branchId={session.branch_id}
          catalogEnabled={session.created_by === currentUser?.user_id}
          validateModelSelection
          enableSaveAsDefault
          showEffort
          mcpLoading={!sessionMcpLoaded}
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
