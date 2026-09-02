import type {
  AgenticToolName,
  AgorClient,
  CodexApprovalPolicy,
  CodexSandboxMode,
  CreateRepoRequest,
  EffortLevel,
  MCPServer,
  PermissionMode,
  Repo,
  User,
} from '@agor-live/client';
import { getDefaultPermissionMode, mapToCodexPermissionConfig } from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import { Collapse, Form, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { slugify } from '@/utils/repoSlug';
import { useEnsureFrameworkRepo } from '../../../hooks/useEnsureFrameworkRepo';
import { useTeammateForm } from '../../../hooks/useTeammateForm';
import type { AgenticToolOption } from '../../../types';
import {
  BLANK_TEMPLATE_ID,
  getTeammateTemplate,
  type TeammateGalleryCardId,
} from '../../../utils/teammateTemplates';
import { buildConfigFromFormValues, getFormValuesFromConfig } from '../../AgenticToolConfigForm';
import {
  AgenticToolConfigurationPicker,
  INLINE_AGENTIC_CONFIGURATION,
} from '../../AgenticToolConfigurationPicker';
import { AgentSelectionGrid } from '../../AgentSelectionGrid';
import { TeammateTemplatePicker } from '../../CreateModals/TeammateTemplatePicker';
import { TeammateFormFields } from '../../forms/TeammateFormFields';
import type { ModelConfig } from '../../ModelSelector';

export interface TeammateTabResult {
  displayName: string;
  description?: string;
  emoji?: string;
  repoId?: string;
  branchName?: string;
  sourceBranch?: string;
  agent: AgenticToolName;
  agenticToolPresetId?: string;
  modelConfig?: ModelConfig;
  effort?: EffortLevel;
  mcpServerIds?: string[];
  permissionMode?: PermissionMode;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
}

export interface TeammateTabProps {
  repoById: Map<string, Repo>;
  onValidityChange: (valid: boolean) => void;
  formRef: React.MutableRefObject<(() => Promise<TeammateTabResult | null>) | null>;
  onCreateRepo?: (data: CreateRepoRequest) => unknown;
  availableAgents: AgenticToolOption[];
  mcpServerById?: Map<string, MCPServer>;
  currentUser?: User | null;
  client?: AgorClient | null;
}

export const TeammateTab: React.FC<TeammateTabProps> = ({
  repoById,
  onValidityChange,
  formRef,
  onCreateRepo,
  availableAgents,
  mcpServerById = new Map(),
  currentUser,
  client,
}) => {
  const repos = Array.from(repoById.values());
  const { frameworkRepo, isCloning } = useEnsureFrameworkRepo(repos, onCreateRepo);
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName>('claude-code');
  const [templateId, setTemplateId] = useState<TeammateGalleryCardId | null>(null);

  const {
    form,
    isFormValid,
    customRepoSelected,
    setCustomRepoSelected,
    validateForm,
    applyDisplayName,
    handleDisplayNameChange,
  } = useTeammateForm(frameworkRepo);

  // Selecting a template prefills the editable fields live. Blank (or clearing)
  // leaves user input untouched and just resets the source branch to default.
  const handleTemplateChange = (id: TeammateGalleryCardId | null) => {
    setTemplateId(id);
    const template = id ? getTeammateTemplate(id) : undefined;
    if (!id || id === BLANK_TEMPLATE_ID || !template) {
      form.setFieldValue('sourceBranch', 'main');
      validateForm();
      return;
    }
    form.setFieldsValue({
      displayName: template.title,
      emoji: template.emoji || '🤖',
      description: template.description,
      sourceBranch: template.sourceBranch,
      repoId: frameworkRepo?.repo_id,
    });
    applyDisplayName(template.title);
  };

  useEffect(() => {
    if (!availableAgents.some((agent) => agent.id === selectedAgent) && availableAgents[0]?.id) {
      setSelectedAgent(availableAgents[0].id as AgenticToolName);
    }
  }, [availableAgents, selectedAgent]);

  useEffect(() => {
    const agentDefaults = currentUser?.default_agentic_config?.[selectedAgent];
    form.setFieldsValue({
      ...getFormValuesFromConfig(selectedAgent, agentDefaults),
      ...(selectedAgent !== 'codex' && {
        codexSandboxMode: undefined,
        codexApprovalPolicy: undefined,
        codexNetworkAccess: undefined,
      }),
    });
  }, [selectedAgent, currentUser, form]);

  // Sync form validity to parent
  useEffect(() => {
    onValidityChange(isFormValid);
  }, [isFormValid, onValidityChange]);

  formRef.current = async () => {
    try {
      const values = await form.validateFields();
      const agentDefaults = currentUser?.default_agentic_config?.[selectedAgent];
      const permissionMode: PermissionMode =
        (values.permissionMode as PermissionMode | undefined) ??
        agentDefaults?.permissionMode ??
        getDefaultPermissionMode(selectedAgent);

      const isInline = values.agenticToolPresetId === INLINE_AGENTIC_CONFIGURATION;
      const inlineAgentConfig = isInline
        ? buildConfigFromFormValues(selectedAgent, {
            modelConfig: values.modelConfig,
            effort: values.effort,
            permissionMode: values.permissionMode,
            codexSandboxMode: values.codexSandboxMode,
            codexApprovalPolicy: values.codexApprovalPolicy,
            codexNetworkAccess: values.codexNetworkAccess,
          })
        : undefined;

      const result: TeammateTabResult = {
        displayName: values.displayName.trim(),
        description: values.description || undefined,
        emoji: values.emoji || undefined,
        repoId: values.repoId || frameworkRepo?.repo_id,
        branchName: values.name || `private-${slugify(values.displayName)}`,
        sourceBranch: values.sourceBranch || 'main',
        agent: selectedAgent,
        agenticToolPresetId: isInline ? undefined : values.agenticToolPresetId,
        modelConfig: isInline
          ? inlineAgentConfig?.modelConfig
          : (values.modelConfig ?? agentDefaults?.modelConfig),
        effort: isInline
          ? undefined
          : ((values.effort as EffortLevel | undefined) ?? agentDefaults?.modelConfig?.effort),
        mcpServerIds: values.mcpServerIds ?? currentUser?.default_mcp_server_ids,
        permissionMode,
      };

      if (selectedAgent === 'codex') {
        const codexDefaults = mapToCodexPermissionConfig(permissionMode);
        result.codexSandboxMode =
          (values.codexSandboxMode as CodexSandboxMode | undefined) ??
          agentDefaults?.codexSandboxMode ??
          codexDefaults.sandboxMode;
        result.codexApprovalPolicy =
          (values.codexApprovalPolicy as CodexApprovalPolicy | undefined) ??
          agentDefaults?.codexApprovalPolicy ??
          codexDefaults.approvalPolicy;
        result.codexNetworkAccess =
          values.codexNetworkAccess ??
          agentDefaults?.codexNetworkAccess ??
          codexDefaults.networkAccess;
      }

      return result;
    } catch {
      return null;
    }
  };

  return (
    <>
      <TeammateTemplatePicker value={templateId} onChange={handleTemplateChange} />
      <Form
        form={form}
        layout="vertical"
        onFieldsChange={validateForm}
        initialValues={{ sourceBranch: 'main' }}
      >
        <TeammateFormFields
          form={form}
          repos={repos}
          frameworkRepo={frameworkRepo}
          isCloning={isCloning}
          onDisplayNameChange={handleDisplayNameChange}
          customRepoSelected={customRepoSelected}
          onCustomRepoChange={setCustomRepoSelected}
          extraBeforeAdvanced={
            <Collapse
              ghost
              size="small"
              defaultActiveKey={['first-session']}
              destroyOnHidden={false}
              expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
              items={[
                {
                  key: 'first-session',
                  label: <Typography.Text strong>First Session Configuration</Typography.Text>,
                  children: (
                    <>
                      <Form.Item label="Agentic Tool" required>
                        <AgentSelectionGrid
                          agents={availableAgents}
                          selectedAgentId={selectedAgent}
                          onSelect={(agentId) => setSelectedAgent(agentId as AgenticToolName)}
                          variant="select"
                          showComparisonLink
                          fallbackToFirstVisibleAgent
                        />
                      </Form.Item>

                      <Collapse
                        ghost
                        size="small"
                        destroyOnHidden={false}
                        expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
                        items={[
                          {
                            key: 'session-config',
                            label: (
                              <Typography.Text type="secondary">
                                Session Configuration
                              </Typography.Text>
                            ),
                            children: (
                              <AgenticToolConfigurationPicker
                                tool={selectedAgent}
                                mcpServerById={mcpServerById}
                                showHelpText={false}
                                client={client ?? null}
                                currentUser={currentUser}
                              />
                            ),
                          },
                        ]}
                      />
                    </>
                  ),
                },
              ]}
              style={{ marginBottom: 8 }}
            />
          }
        />
      </Form>
    </>
  );
};
