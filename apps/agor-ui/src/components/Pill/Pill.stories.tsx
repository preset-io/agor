import { CodeOutlined, FolderOutlined } from '@ant-design/icons';
import type { Meta, StoryObj } from '@storybook/react';
import { Space } from 'antd';
import { EventStreamPill } from './EventStreamPill';
import {
  ConceptPill,
  DirtyStatePill,
  ForkPill,
  GitShaPill,
  MessageCountPill,
  ReportPill,
  SessionIdPill,
  SpawnPill,
  StatusPill,
  ToolCountPill,
  WorktreePill,
} from './Pill';
import { SessionMetadataCard } from './SessionMetadataCard';
import { TimerPill } from './TimerPill';

const meta = {
  title: 'Components/Pill',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj;

export const AllPills: Story = {
  render: () => (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <h3>Metadata Pills</h3>
        <Space wrap>
          <MessageCountPill count={42} />
          <MessageCountPill count={1} />
          <ToolCountPill count={15} />
          <ToolCountPill count={3} toolName="Read" />
          <SessionIdPill sessionId="0199b856-1234-5678-9abc-def012345678" showCopy={true} />
          <SessionIdPill sessionId="0199b856-1234-5678-9abc-def012345678" showCopy={false} />
        </Space>
      </div>

      <div>
        <h3>Git Pills</h3>
        <Space wrap>
          <GitShaPill sha="abc123def456" />
          <GitShaPill sha="abc123def456-dirty" isDirty={true} />
          <GitShaPill sha="abc123def456-dirty" isDirty={true} showDirtyIndicator={false} />
          <DirtyStatePill />
        </Space>
      </div>

      <div>
        <h3>Status Pills</h3>
        <Space wrap>
          <StatusPill status="completed" />
          <StatusPill status="failed" />
          <StatusPill status="running" />
          <StatusPill status="pending" />
        </Space>
      </div>

      <div>
        <h3>Timer Pills</h3>
        <Space wrap>
          <TimerPill status="running" startedAt={new Date(Date.now() - 90_000)} />
          <TimerPill
            status="completed"
            startedAt={new Date(Date.now() - 10 * 60 * 1000)}
            endedAt={new Date(Date.now() - 8 * 60 * 1000)}
          />
        </Space>
      </div>

      <div>
        <h3>Genealogy Pills</h3>
        <Space wrap>
          <ForkPill fromSessionId="0199b850-d329-7893-bc1c-197cbf4f4a7f" />
          <ForkPill
            fromSessionId="0199b850-d329-7893-bc1c-197cbf4f4a7f"
            taskId="0199b851-1234-5678-9abc-def012345678"
          />
          <SpawnPill fromSessionId="0199b850-d329-7893-bc1c-197cbf4f4a7f" />
          <SpawnPill
            fromSessionId="0199b850-d329-7893-bc1c-197cbf4f4a7f"
            taskId="0199b851-1234-5678-9abc-def012345678"
          />
        </Space>
      </div>

      <div>
        <h3>Feature Pills</h3>
        <Space wrap>
          <ReportPill />
          <ReportPill reportId="0199b852-1234-5678-9abc-def012345678" />
          <ConceptPill name="authentication" />
          <ConceptPill name="database-schema" />
          <WorktreePill managed={true} />
          <WorktreePill managed={false} />
        </Space>
      </div>
    </Space>
  ),
};

export const MessageCount: Story = {
  render: () => (
    <Space>
      <MessageCountPill count={1} />
      <MessageCountPill count={42} />
      <MessageCountPill count={1337} />
    </Space>
  ),
};

export const ToolCount: Story = {
  render: () => (
    <Space>
      <ToolCountPill count={0} />
      <ToolCountPill count={5} />
      <ToolCountPill count={3} toolName="Read" />
      <ToolCountPill count={7} toolName="Edit" />
    </Space>
  ),
};

export const GitSha: Story = {
  render: () => (
    <Space>
      <GitShaPill sha="abc123def456" />
      <GitShaPill sha="abc123def456-dirty" isDirty={true} />
      <GitShaPill sha="abc123def456-dirty" isDirty={true} showDirtyIndicator={false} />
    </Space>
  ),
};

export const SessionId: Story = {
  render: () => (
    <Space>
      <SessionIdPill sessionId="0199b856-1234-5678-9abc-def012345678" showCopy={true} />
      <SessionIdPill sessionId="0199b856-1234-5678-9abc-def012345678" showCopy={false} />
    </Space>
  ),
};

export const Status: Story = {
  render: () => (
    <Space>
      <StatusPill status="completed" />
      <StatusPill status="failed" />
      <StatusPill status="running" />
      <StatusPill status="pending" />
    </Space>
  ),
};

export const Timer: Story = {
  render: () => (
    <Space>
      <TimerPill status="running" startedAt={new Date(Date.now() - 45_000)} />
      <TimerPill
        status="completed"
        startedAt={new Date(Date.now() - 6 * 60 * 1000)}
        endedAt={new Date(Date.now() - 3 * 60 * 1000)}
      />
      <TimerPill
        status="failed"
        startedAt={new Date(Date.now() - 5 * 60 * 1000)}
        endedAt={new Date(Date.now() - 4 * 60 * 1000)}
      />
    </Space>
  ),
};

export const Genealogy: Story = {
  render: () => (
    <Space direction="vertical">
      <Space>
        <ForkPill fromSessionId="0199b850-d329-7893-bc1c-197cbf4f4a7f" />
        <ForkPill
          fromSessionId="0199b850-d329-7893-bc1c-197cbf4f4a7f"
          taskId="0199b851-1234-5678-9abc-def012345678"
        />
      </Space>
      <Space>
        <SpawnPill fromSessionId="0199b850-d329-7893-bc1c-197cbf4f4a7f" />
        <SpawnPill
          fromSessionId="0199b850-d329-7893-bc1c-197cbf4f4a7f"
          taskId="0199b851-1234-5678-9abc-def012345678"
        />
      </Space>
    </Space>
  ),
};

export const Features: Story = {
  render: () => (
    <Space>
      <ReportPill />
      <ReportPill reportId="0199b852-1234-5678-9abc-def012345678" />
      <ConceptPill name="authentication" />
      <WorktreePill managed={true} />
      <DirtyStatePill />
    </Space>
  ),
};

export const EventStream: Story = {
  render: () => (
    <Space direction="vertical" size="large">
      <div>
        <h3>EventStreamPill - Basic (no popover)</h3>
        <Space wrap>
          <EventStreamPill
            id="0199b856-1234-5678-9abc-def012345678"
            icon={CodeOutlined}
            color="cyan"
            copyLabel="Session ID"
          />
          <EventStreamPill
            id="0199b857-abcd-1234-5678-9abcdef01234"
            label="auth-fix"
            icon={FolderOutlined}
            color="geekblue"
            copyLabel="Worktree ID"
          />
        </Space>
      </div>

      <div>
        <h3>EventStreamPill - With Metadata Card (hover to see)</h3>
        <Space wrap>
          <EventStreamPill
            id="0199b856-1234-5678-9abc-def012345678"
            icon={CodeOutlined}
            color="cyan"
            copyLabel="Session ID"
            metadataCard={
              <SessionMetadataCard
                session={{
                  session_id: '0199b856-1234-5678-9abc-def012345678',
                  sdk_session_id: 'sdk-01a1b2c3',
                  agentic_tool: 'claude-code',
                  title: 'Fix authentication middleware bug',
                  description: 'Add JWT validation to auth middleware',
                  status: 'running',
                  created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
                  last_updated: new Date().toISOString(),
                  created_by: 'user-123',
                  worktree_id: 'worktree-456',
                  git_state: { ref: 'auth-fix', base_sha: 'abc123', current_sha: 'def456' },
                  contextFiles: [],
                  genealogy: {
                    forked_from_session_id: '0199b850-d329-7893-bc1c-197cbf4f4a7f',
                    children: [],
                  },
                  tasks: [],
                  message_count: 15,
                  permission_config: { mode: 'auto' },
                  scheduled_from_worktree: false,
                  ready_for_prompt: false,
                  archived: false,
                }}
                worktree={{
                  worktree_id: 'worktree-456',
                  name: 'auth-fix',
                  repo_id: 'repo-789',
                  path: '/Users/dev/.agor/worktrees/my-app/auth-fix',
                  ref: 'auth-fix',
                  base_ref: 'main',
                  new_branch: true,
                  worktree_unique_id: 1,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  created_by: 'user-123',
                  schedule_enabled: false,
                  needs_attention: false,
                  archived: false,
                }}
                repo={{
                  repo_id: 'repo-789',
                  slug: 'my-org/my-app',
                  repo_type: 'github',
                  remote_url: 'https://github.com/my-org/my-app',
                  local_path: '/Users/dev/projects/my-app',
                  default_branch: 'main',
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  created_by: 'user-123',
                }}
                userById={
                  new Map([
                    [
                      'user-123',
                      {
                        user_id: 'user-123',
                        email: 'dev@example.com',
                        name: 'Alice Developer',
                        role: 'member',
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                      },
                    ],
                  ])
                }
                currentUserId="user-456"
                compact
              />
            }
          />
        </Space>
      </div>
    </Space>
  ),
};

export const SessionMetadata: Story = {
  render: () => (
    <Space direction="vertical" size="large">
      <div>
        <h3>Running Session (Forked)</h3>
        <SessionMetadataCard
          session={{
            session_id: '0199b856-1234-5678-9abc-def012345678',
            sdk_session_id: 'sdk-01a1b2c3',
            agentic_tool: 'claude-code',
            title: 'Fix authentication middleware bug',
            description: 'Add JWT validation to auth middleware',
            status: 'running',
            created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            last_updated: new Date().toISOString(),
            created_by: 'user-123',
            worktree_id: 'worktree-456',
            git_state: { ref: 'auth-fix', base_sha: 'abc123', current_sha: 'def456' },
            contextFiles: [],
            genealogy: {
              forked_from_session_id: '0199b850-d329-7893-bc1c-197cbf4f4a7f',
              children: [],
            },
            tasks: [],
            message_count: 15,
            permission_config: { mode: 'auto' },
            scheduled_from_worktree: false,
            ready_for_prompt: false,
            archived: false,
          }}
          worktree={{
            worktree_id: 'worktree-456',
            name: 'auth-fix',
            repo_id: 'repo-789',
            path: '/Users/dev/.agor/worktrees/my-app/auth-fix',
            ref: 'auth-fix',
            base_ref: 'main',
            new_branch: true,
            worktree_unique_id: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            created_by: 'user-123',
            schedule_enabled: false,
            needs_attention: false,
            archived: false,
          }}
          repo={{
            repo_id: 'repo-789',
            slug: 'my-org/my-app',
            repo_type: 'github',
            remote_url: 'https://github.com/my-org/my-app',
            local_path: '/Users/dev/projects/my-app',
            default_branch: 'main',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            created_by: 'user-123',
          }}
          userById={
            new Map([
              [
                'user-123',
                {
                  user_id: 'user-123',
                  email: 'dev@example.com',
                  name: 'Alice Developer',
                  role: 'member',
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ],
            ])
          }
          currentUserId="user-456"
          compact
        />
      </div>

      <div>
        <h3>Completed Session (Spawned)</h3>
        <SessionMetadataCard
          session={{
            session_id: '0199b858-5678-abcd-1234-56789abcdef0',
            agentic_tool: 'codex',
            title: 'Run integration tests',
            status: 'completed',
            created_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
            last_updated: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
            created_by: 'user-123',
            worktree_id: 'worktree-456',
            git_state: { ref: 'test-suite', base_sha: 'abc123', current_sha: 'def456' },
            contextFiles: [],
            genealogy: {
              parent_session_id: '0199b850-d329-7893-bc1c-197cbf4f4a7f',
              children: [],
            },
            tasks: [],
            message_count: 8,
            permission_config: {
              mode: 'auto',
              codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
            },
            scheduled_from_worktree: false,
            ready_for_prompt: false,
            archived: false,
          }}
          users={[
            {
              user_id: 'user-123',
              email: 'dev@example.com',
              name: 'Alice Developer',
              role: 'member',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ]}
          currentUserId="user-123"
          compact
        />
      </div>

      <div>
        <h3>Failed Session (No Genealogy)</h3>
        <SessionMetadataCard
          session={{
            session_id: '0199b859-9abc-def0-1234-56789abcdef0',
            sdk_session_id: 'gemini-thread-xyz789',
            agentic_tool: 'gemini',
            description: 'Debug memory leak in worker process',
            status: 'failed',
            created_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
            last_updated: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            created_by: 'user-456',
            worktree_id: 'worktree-789',
            git_state: { ref: 'debug-leak', base_sha: 'abc123', current_sha: 'def456' },
            contextFiles: [],
            genealogy: { children: [] },
            tasks: [],
            message_count: 3,
            permission_config: { mode: 'ask' },
            scheduled_from_worktree: false,
            ready_for_prompt: false,
            archived: false,
          }}
          userById={
            new Map([
              [
                'user-456',
                {
                  user_id: 'user-456',
                  email: 'bob@example.com',
                  name: 'Bob Engineer',
                  role: 'member',
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ],
            ])
          }
          currentUserId="user-456"
          compact
        />
      </div>
    </Space>
  ),
};
