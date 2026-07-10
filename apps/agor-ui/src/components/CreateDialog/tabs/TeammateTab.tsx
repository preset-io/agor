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
import { AgenticToolConfigForm, getFormValuesFromConfig } from '../../AgenticToolConfigForm';
import { AgentSelectionGrid } from '../../AgentSelectionGrid';
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

  const {
    form,
    isFormValid,
    customRepoSelected,
    setCustomRepoSelected,
    validateForm,
    handleDisplayNameChange,
  } = useTeammateForm(frameworkRepo);

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

      const result: TeammateTabResult = {
        displayName: values.displayName.trim(),
        description: values.description || undefined,
        emoji: values.emoji || undefined,
        repoId: values.repoId || frameworkRepo?.repo_id,
        branchName: values.name || `private-${slugify(values.displayName)}`,
        sourceBranch: values.sourceBranch || 'main',
        agent: selectedAgent,
        modelConfig: values.modelConfig ?? agentDefaults?.modelConfig,
        effort: (values.effort as EffortLevel | undefined) ?? agentDefaults?.modelConfig?.effort,
        mcpServerIds: values.mcpServerIds ?? agentDefaults?.mcpServerIds,
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
                            <AgenticToolConfigForm
                              agenticTool={selectedAgent}
                              mcpServerById={mcpServerById}
                              showHelpText={false}
                              client={client}
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
  );
};
