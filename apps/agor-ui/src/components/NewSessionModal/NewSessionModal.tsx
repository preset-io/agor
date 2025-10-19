import type { MCPServer, PermissionMode } from '@agor/core/types';
import { DownOutlined } from '@ant-design/icons';
import { Checkbox, Collapse, Form, Input, Modal, Radio, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { Agent, AgentName } from '../../types';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { AgentSelectionCard } from '../AgentSelectionCard';
import type { ModelConfig } from '../ModelSelector';

const { TextArea } = Input;
const { Text } = Typography;

export type RepoSetupMode = 'existing-worktree' | 'new-worktree' | 'new-repo';

export interface RepoReferenceOption {
  label: string;
  value: string;
  type: 'managed' | 'managed-worktree';
  description?: string;
}

export interface NewSessionConfig {
  agent: string;
  title?: string;
  initialPrompt?: string;

  // Repo/worktree configuration
  repoSetupMode: RepoSetupMode;

  // For existing-worktree mode
  worktreeRef?: string; // e.g., "anthropics/agor:main"

  // For new-worktree mode
  existingRepoSlug?: string; // e.g., "anthropics/agor"
  newWorktreeName?: string;
  newWorktreeBranch?: string;

  // For new-repo mode
  gitUrl?: string;
  repoSlug?: string;
  initialWorktreeName?: string;
  initialWorktreeBranch?: string;

  // Advanced configuration
  modelConfig?: ModelConfig;
  mcpServerIds?: string[];
  permissionMode?: PermissionMode;
}

export interface NewSessionModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (config: NewSessionConfig) => void;
  availableAgents: Agent[];

  // Repo/worktree options (from backend)
  worktreeOptions?: RepoReferenceOption[]; // All existing worktrees
  repoOptions?: RepoReferenceOption[]; // All repos (for new worktree)

  // MCP servers (from backend)
  mcpServers?: MCPServer[];
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  open,
  onClose,
  onCreate,
  availableAgents,
  worktreeOptions = [],
  repoOptions = [],
  mcpServers = [],
}) => {
  const [form] = Form.useForm();
  const [selectedAgent, setSelectedAgent] = useState<string | null>('claude-code');
  const [repoSetupMode, setRepoSetupMode] = useState<RepoSetupMode>('existing-worktree');
  const [isFormValid, setIsFormValid] = useState(false);
  const [useSameBranchName, setUseSameBranchName] = useState(true);

  // Handle mode change
  const handleModeChange = (newMode: RepoSetupMode) => {
    setRepoSetupMode(newMode);
    // With preserve={false}, fields will reset when unmounted
    // Re-check form validity after mode change
    setTimeout(() => handleFormChange(), 10);
  };

  // Re-validate when useSameBranchName changes (affects which fields are required)
  // biome-ignore lint/correctness/useExhaustiveDependencies: We only want to re-validate when useSameBranchName changes
  useEffect(() => {
    if (repoSetupMode === 'new-worktree') {
      handleFormChange();
    }
  }, [useSameBranchName]);

  const handleCreate = () => {
    form
      .validateFields()
      .then(values => {
        if (!selectedAgent) {
          return;
        }

        onCreate({
          agent: selectedAgent,
          title: values.title,
          initialPrompt: values.initialPrompt,
          repoSetupMode,
          worktreeRef: values.worktreeRef,
          existingRepoSlug: values.existingRepoSlug,
          newWorktreeName: values.newWorktreeName,
          newWorktreeBranch: values.newWorktreeBranch,
          gitUrl: values.gitUrl,
          repoSlug: values.repoSlug,
          initialWorktreeName: values.initialWorktreeName,
          initialWorktreeBranch: values.initialWorktreeBranch,
          modelConfig: values.modelConfig,
          mcpServerIds: values.mcpServerIds,
          permissionMode: values.permissionMode,
        });

        form.resetFields();
        setSelectedAgent('claude-code');
        setRepoSetupMode('existing-worktree');
        onClose();
      })
      .catch(errorInfo => {
        // Validation failed - form will show errors automatically
        console.log('Validation failed:', errorInfo);
      });
  };

  const handleCancel = () => {
    form.resetFields();
    setSelectedAgent('claude-code');
    setRepoSetupMode('existing-worktree');
    setUseSameBranchName(true);
    onClose();
  };

  const handleInstall = (agentId: string) => {
    console.log(`Installing agent: ${agentId}`);
    // TODO: Implement installation flow
  };

  // Check form validity without triggering error display
  const handleFormChange = () => {
    // Use setTimeout to debounce and avoid blocking the UI
    setTimeout(() => {
      // Get current form values
      const values = form.getFieldsValue();

      // Check if required fields are filled based on current mode
      let isValid = false;

      if (repoSetupMode === 'existing-worktree') {
        isValid = !!values.worktreeRef;
      } else if (repoSetupMode === 'new-worktree') {
        isValid = !!values.existingRepoSlug && !!values.newWorktreeName;
        // If checkbox is unchecked, branch name is also required
        if (!useSameBranchName) {
          isValid = isValid && !!values.newWorktreeBranch;
        }
      } else if (repoSetupMode === 'new-repo') {
        isValid = !!values.gitUrl && !!values.initialWorktreeName;
      }

      setIsFormValid(isValid);
    }, 0);
  };

  return (
    <Modal
      title="Create New Session"
      open={open}
      onOk={handleCreate}
      onCancel={handleCancel}
      okText="Create Session"
      cancelText="Cancel"
      width={600}
      okButtonProps={{
        disabled: !selectedAgent || !isFormValid,
        title: !selectedAgent
          ? 'Please select an agent to continue'
          : !isFormValid
            ? 'Please fill in all required fields'
            : undefined,
      }}
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 16 }}
        onFieldsChange={handleFormChange}
        preserve={false}
      >
        <Form.Item label="Select Coding Agent" required>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            {!selectedAgent && (
              <Text type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
                Click on an agent card to select it
              </Text>
            )}
            {availableAgents.map(agent => (
              <AgentSelectionCard
                key={agent.id}
                agent={agent}
                selected={selectedAgent === agent.id}
                onClick={() => setSelectedAgent(agent.id)}
                onInstall={() => handleInstall(agent.id)}
              />
            ))}
          </Space>
        </Form.Item>

        <Collapse
          ghost
          defaultActiveKey={['repository']}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'repository',
              label: <Text strong>Repository & Worktree</Text>,
              children: (
                <>
                  <Form.Item required>
                    <Radio.Group
                      value={repoSetupMode}
                      onChange={e => handleModeChange(e.target.value)}
                    >
                      <Space direction="vertical" style={{ width: '100%' }} size="small">
                        <Radio value="existing-worktree">Use existing worktree</Radio>
                        <Radio value="new-worktree">Create new worktree on existing repo</Radio>
                        <Radio value="new-repo">Add new repository</Radio>
                      </Space>
                    </Radio.Group>
                  </Form.Item>

                  {repoSetupMode === 'existing-worktree' && (
                    <Form.Item
                      name="worktreeRef"
                      label="Select Worktree"
                      rules={[{ required: true, message: 'Please select a worktree' }]}
                      validateTrigger={['onBlur', 'onChange']}
                    >
                      <Select
                        placeholder="Select worktree..."
                        options={worktreeOptions}
                        showSearch
                        optionFilterProp="label"
                      />
                    </Form.Item>
                  )}

                  {repoSetupMode === 'new-worktree' && (
                    <>
                      <Form.Item
                        name="existingRepoSlug"
                        label="Repository"
                        rules={[{ required: true, message: 'Please select a repository' }]}
                        validateTrigger={['onBlur', 'onChange']}
                      >
                        <Select
                          placeholder="Select repository..."
                          options={repoOptions}
                          showSearch
                          optionFilterProp="label"
                        />
                      </Form.Item>
                      <Form.Item
                        name="newWorktreeName"
                        label="Worktree Name"
                        rules={[{ required: true, message: 'Please enter worktree name' }]}
                        validateTrigger={['onBlur', 'onChange']}
                      >
                        <Input placeholder="e.g., feat-auth" />
                      </Form.Item>
                      <Form.Item>
                        <Checkbox
                          checked={useSameBranchName}
                          onChange={e => {
                            setUseSameBranchName(e.target.checked);
                            if (e.target.checked) {
                              // Clear branch field when checkbox is checked
                              form.setFieldValue('newWorktreeBranch', undefined);
                            }
                            // Re-validate form after checkbox change
                            handleFormChange();
                          }}
                        >
                          Use worktree name as branch name
                        </Checkbox>
                      </Form.Item>
                      {!useSameBranchName && (
                        <Form.Item
                          name="newWorktreeBranch"
                          label="Branch Name"
                          rules={[{ required: true, message: 'Please enter branch name' }]}
                          validateTrigger={['onBlur', 'onChange']}
                        >
                          <Input placeholder="e.g., feature/auth" />
                        </Form.Item>
                      )}
                    </>
                  )}

                  {repoSetupMode === 'new-repo' && (
                    <>
                      <Form.Item
                        name="gitUrl"
                        label="Git URL"
                        rules={[
                          { required: true, message: 'Please enter git URL' },
                          { type: 'url', message: 'Please enter a valid URL' },
                        ]}
                        validateTrigger={['onBlur', 'onChange']}
                      >
                        <Input placeholder="https://github.com/org/repo.git" />
                      </Form.Item>
                      <Form.Item
                        name="repoSlug"
                        label="Repository Slug"
                        help="Auto-detected from URL (can be customized)"
                      >
                        <Input placeholder="org/repo" />
                      </Form.Item>
                      <Form.Item
                        name="initialWorktreeName"
                        label="Initial Worktree Name"
                        rules={[{ required: true, message: 'Please enter initial worktree name' }]}
                        validateTrigger={['onBlur', 'onChange']}
                      >
                        <Input placeholder="main" />
                      </Form.Item>
                      <Form.Item name="initialWorktreeBranch" label="Branch (optional)">
                        <Input placeholder="main" />
                      </Form.Item>
                    </>
                  )}
                </>
              ),
            },
          ]}
        />

        <Form.Item
          name="title"
          label="Session Title (optional)"
          help="A short descriptive name for this session"
        >
          <Input placeholder="e.g., Auth System Implementation" />
        </Form.Item>

        <Form.Item
          name="initialPrompt"
          label="Initial Prompt (optional)"
          help="What should this session work on?"
        >
          <TextArea
            rows={4}
            placeholder="e.g., Build a JWT authentication system with secure password storage..."
          />
        </Form.Item>

        <Collapse
          ghost
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'agentic-tool-config',
              label: <Text strong>Agentic Tool Configuration</Text>,
              children: (
                <AgenticToolConfigForm
                  agenticTool={(selectedAgent as AgentName) || 'claude-code'}
                  mcpServers={mcpServers}
                  showHelpText={true}
                />
              ),
            },
          ]}
          style={{ marginTop: 16 }}
        />
      </Form>
    </Modal>
  );
};
