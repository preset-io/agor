import type { MCPServer } from '@agor/core/types';
import { Collapse, Form, Input, Modal, Radio, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import type { Agent } from '../../types';
import { AgentSelectionCard } from '../AgentSelectionCard';
import { MCPServerSelect } from '../MCPServerSelect';

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

  // MCP server associations
  mcpServerIds?: string[];
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

  const handleCreate = () => {
    form.validateFields().then(values => {
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
        mcpServerIds: values.mcpServerIds,
      });

      form.resetFields();
      setSelectedAgent('claude-code');
      setRepoSetupMode('existing-worktree');
      onClose();
    });
  };

  const handleCancel = () => {
    form.resetFields();
    setSelectedAgent('claude-code');
    setRepoSetupMode('existing-worktree');
    onClose();
  };

  const handleInstall = (agentId: string) => {
    console.log(`Installing agent: ${agentId}`);
    // TODO: Implement installation flow
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
        disabled: !selectedAgent,
        title: !selectedAgent ? 'Please select an agent to continue' : undefined,
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
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

        <Form.Item label="Repository & Worktree" required>
          <Radio.Group value={repoSetupMode} onChange={e => setRepoSetupMode(e.target.value)}>
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
            >
              <Input placeholder="e.g., feat-auth" />
            </Form.Item>
            <Form.Item name="newWorktreeBranch" label="Branch (optional)">
              <Input placeholder="e.g., feature/auth" />
            </Form.Item>
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
            >
              <Input placeholder="main" />
            </Form.Item>
            <Form.Item name="initialWorktreeBranch" label="Branch (optional)">
              <Input placeholder="main" />
            </Form.Item>
          </>
        )}

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

        <Form.Item
          name="mcpServerIds"
          label="MCP Servers (optional)"
          help="Select MCP servers to make available in this session"
        >
          <MCPServerSelect mcpServers={mcpServers} />
        </Form.Item>
      </Form>
    </Modal>
  );
};
