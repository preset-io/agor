import { generateId } from '@agor/core/ids/browser';
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
import {
  getDefaultPermissionMode,
  mapToCodexPermissionConfig,
  TEAMMATE_FRAMEWORK_REPO_URL,
} from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import { Button, Collapse, Flex, Form, Input, Typography } from 'antd';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { slugify } from '@/utils/repoSlug';
import { useTeammateForm } from '../../../hooks/useTeammateForm';
import type { AgenticToolOption } from '../../../types';
import type { GalleryFilter } from '../../../utils/teammateTemplates';
import {
  resolveTemplateSourceBranch,
  resolveTemplateSourceRemoteUrl,
  type TeammateGalleryCardId,
} from '../../../utils/teammateTemplates';
import { buildConfigFromFormValues, getFormValuesFromConfig } from '../../AgenticToolConfigForm';
import {
  AgenticToolConfigurationPicker,
  INLINE_AGENTIC_CONFIGURATION,
} from '../../AgenticToolConfigurationPicker';
import { AgentSelectionGrid } from '../../AgentSelectionGrid';
import { TeammateFormFields } from '../../forms/TeammateFormFields';
import { TeammateHome } from '../../forms/TeammateHome';
import type { ModelConfig } from '../../ModelSelector';
import {
  TeammateGalleryCards,
  TeammateGalleryFilters,
} from '../../TeammateGallery/TeammateGallery';

export interface TeammateTabResult {
  displayName: string;
  description?: string;
  emoji?: string;
  repoId?: string;
  branchName?: string;
  sourceBranch?: string;
  sourceRemoteUrl?: string;
  creationBoardId: string;
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
  onValidityChange,
  formRef,
  availableAgents,
  mcpServerById = new Map(),
  currentUser,
  client,
}) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [homeStep, setHomeStep] = useState(false);
  const [filter, setFilter] = useState<GalleryFilter>('all');
  const [destinationReady, setDestinationReady] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [templateId, setTemplateId] = useState<TeammateGalleryCardId | null>(null);
  const creationBoardId = useRef(generateId());
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName>('claude-code');

  const { form, isFormValid, validateForm, handleDisplayNameChange } = useTeammateForm();

  const destinationId = Form.useWatch('repoId', form);
  // This form can outlive a directory/auth user change in the application shell.
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity change erases the private draft and partial-attempt IDs
  useLayoutEffect(() => {
    form.resetFields();
    setHomeStep(false);
    setFilter('all');
    setAcknowledged(false);
    setDestinationReady(false);
    setTemplateId(null);
    creationBoardId.current = generateId();
  }, [currentUser?.user_id]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = homeStep
        ? surfaceRef.current?.querySelector<HTMLElement>('[data-home-heading]')
        : (surfaceRef.current?.querySelector<HTMLElement>('[role="button"][aria-pressed="true"]') ??
          surfaceRef.current?.querySelector<HTMLElement>('input[id$="displayName"]'));
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [homeStep]);

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
    onValidityChange(homeStep && isFormValid && destinationReady && acknowledged);
  }, [isFormValid, onValidityChange, homeStep, destinationReady, acknowledged]);

  formRef.current = async () => {
    try {
      if (!homeStep || !destinationReady || !acknowledged) return null;
      await form.validateFields();
      // Advanced fields may never have mounted; include their canonical defaults
      // and retained explicit overrides instead of falling back to destination main.
      const values = form.getFieldsValue(true);
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
        repoId: values.repoId,
        creationBoardId: creationBoardId.current,
        sourceRemoteUrl: values.sourceRemoteUrl?.trim() || undefined,
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
    <div ref={surfaceRef}>
      <Form
        form={form}
        layout="vertical"
        className={!homeStep ? 'create-teammate-persona' : undefined}
        onFieldsChange={validateForm}
        initialValues={{ sourceBranch: 'main', sourceRemoteUrl: TEAMMATE_FRAMEWORK_REPO_URL }}
      >
        <TeammateFormFields
          form={form}
          homeStep={homeStep}
          onDisplayNameChange={handleDisplayNameChange}
          extraBeforeAdvanced={
            !homeStep ? (
              <Flex vertical gap="small" className="create-teammate-picker">
                <div style={{ minWidth: 0, overflowX: 'auto', flexShrink: 0 }}>
                  <TeammateGalleryFilters value={filter} onChange={setFilter} />
                </div>
                <div className="create-teammate-gallery">
                  <TeammateGalleryCards
                    filter={filter}
                    value={templateId}
                    onChange={(id) => {
                      setTemplateId(id);
                      form.setFieldsValue({
                        sourceBranch: resolveTemplateSourceBranch(id),
                        sourceRemoteUrl: resolveTemplateSourceRemoteUrl(id),
                      });
                    }}
                  />
                </div>
                <Button
                  style={{ flexShrink: 0 }}
                  onClick={async () => {
                    try {
                      await form.validateFields(['displayName']);
                      setHomeStep(true);
                      setFilter('all');
                    } catch {}
                  }}
                >
                  Continue to home →
                </Button>
              </Flex>
            ) : (
              <>
                <Typography.Title data-home-heading tabIndex={-1} level={4}>
                  Choose your teammate’s home
                </Typography.Title>
                <Button onClick={() => setHomeStep(false)}>Back to persona</Button>
                <Form.Item name="repoId" hidden>
                  <Input />
                </Form.Item>
                <TeammateHome
                  client={client ?? null}
                  user={currentUser}
                  repoId={destinationId}
                  onChange={(id) => {
                    form.setFieldValue('repoId', id);
                    validateForm();
                  }}
                  onReadyChange={setDestinationReady}
                  acknowledged={acknowledged}
                  onAcknowledgedChange={setAcknowledged}
                />
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
                            expandIcon={({ isActive }) => (
                              <DownOutlined rotate={isActive ? 180 : 0} />
                            )}
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
              </>
            )
          }
        />
      </Form>
    </div>
  );
};
