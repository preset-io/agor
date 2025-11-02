/**
 * Tests for permission-hooks.ts
 *
 * Tests permission hook functionality including:
 * - Project settings file management
 * - PreToolUse hook creation and execution
 * - Permission lock serialization
 * - Hook context handling and decision flow
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagesRepository } from '../../../db/repositories/messages';
import type { SessionRepository } from '../../../db/repositories/sessions';
import type { WorktreeRepository } from '../../../db/repositories/worktrees';
import { generateId } from '../../../lib/ids';
import type { PermissionService } from '../../../permissions/permission-service';
import type {
  Message,
  MessageID,
  Session,
  SessionID,
  TaskID,
  UUID,
  Worktree,
  WorktreeID,
} from '../../../types';
import { MessageRole, PermissionScope, PermissionStatus, TaskStatus } from '../../../types';
import type { MessagesService, SessionsService, TasksService } from '../claude-tool';
import { createPreToolUseHook, updateProjectSettings } from './permission-hooks';

describe('updateProjectSettings', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should create settings file if it does not exist', async () => {
    await updateProjectSettings(tmpDir, {
      allowTools: ['Bash', 'Read'],
    });

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    expect(settings.permissions.allow.tools).toEqual(['Bash', 'Read']);
  });

  it('should create .claude directory if it does not exist', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    await expect(fs.access(claudeDir)).rejects.toThrow();

    await updateProjectSettings(tmpDir, {
      allowTools: ['Bash'],
    });

    await expect(fs.access(claudeDir)).resolves.toBeUndefined();
  });

  it('should append to existing allowed tools', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        permissions: {
          allow: {
            tools: ['Bash'],
          },
        },
      })
    );

    await updateProjectSettings(tmpDir, {
      allowTools: ['Read', 'Write'],
    });

    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    expect(settings.permissions.allow.tools).toEqual(['Bash', 'Read', 'Write']);
  });

  it('should deduplicate allowed tools', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        permissions: {
          allow: {
            tools: ['Bash', 'Read'],
          },
        },
      })
    );

    await updateProjectSettings(tmpDir, {
      allowTools: ['Read', 'Write', 'Bash'],
    });

    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    // Should have unique tools only
    expect(settings.permissions.allow.tools).toHaveLength(3);
    expect(new Set(settings.permissions.allow.tools).size).toBe(3);
  });

  it('should create deny list if it does not exist', async () => {
    await updateProjectSettings(tmpDir, {
      denyTools: ['Bash'],
    });

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    expect(settings.permissions.deny).toEqual(['Bash']);
  });

  it('should append to existing deny list', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        permissions: {
          deny: ['Bash'],
        },
      })
    );

    await updateProjectSettings(tmpDir, {
      denyTools: ['Write'],
    });

    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    expect(settings.permissions.deny).toEqual(['Bash', 'Write']);
  });

  it('should handle both allow and deny tools in single call', async () => {
    await updateProjectSettings(tmpDir, {
      allowTools: ['Read', 'Edit'],
      denyTools: ['Bash'],
    });

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    expect(settings.permissions.allow.tools).toEqual(['Read', 'Edit']);
    expect(settings.permissions.deny).toEqual(['Bash']);
  });

  it('should preserve existing settings structure', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        customField: 'value',
        permissions: {
          allow: {
            tools: [],
          },
          customPermission: true,
        },
      })
    );

    await updateProjectSettings(tmpDir, {
      allowTools: ['Bash'],
    });

    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    expect(settings.customField).toBe('value');
    expect(settings.permissions.customPermission).toBe(true);
  });

  it('should format JSON with 2-space indentation', async () => {
    await updateProjectSettings(tmpDir, {
      allowTools: ['Bash'],
    });

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const content = await fs.readFile(settingsPath, 'utf-8');

    // Check for 2-space indentation
    expect(content).toContain('  "permissions"');
  });

  it('should handle empty changes', async () => {
    await updateProjectSettings(tmpDir, {});

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    expect(settings.permissions.allow.tools).toEqual([]);
  });

  it('should handle malformed JSON by creating default structure', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, 'invalid json content');

    await updateProjectSettings(tmpDir, {
      allowTools: ['Bash'],
    });

    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    expect(settings.permissions.allow.tools).toEqual(['Bash']);
  });
});

describe('createPreToolUseHook', () => {
  const sessionId = generateId() as SessionID;
  const taskId = generateId() as TaskID;
  const messageId = generateId() as MessageID;

  // Helper to create mock dependencies
  function createMockDeps(overrides?: {
    permissionService?: Partial<PermissionService>;
    tasksService?: Partial<TasksService>;
    sessionsRepo?: Partial<SessionRepository>;
    messagesRepo?: Partial<MessagesRepository>;
    messagesService?: Partial<MessagesService> & {
      patch?: (id: string, data: any) => Promise<any>;
    };
    sessionsService?: Partial<SessionsService>;
    worktreesRepo?: Partial<WorktreeRepository>;
    session?: Session;
  }) {
    const permissionLocks = new Map<SessionID, Promise<void>>();

    const permissionService: Partial<PermissionService> = {
      emitRequest: vi.fn(),
      waitForDecision: vi.fn(),
    };

    const tasksService: Partial<TasksService> = {
      patch: vi.fn().mockResolvedValue({}),
    };

    const session: Session = {
      session_id: sessionId,
      worktree_id: generateId() as WorktreeID,
      title: 'Test Session',
      agentic_tool: 'claude-code',
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      status: 'idle',
      created_by: generateId() as UUID,
      git_state: {
        ref: 'main',
        base_sha: 'abc123',
        current_sha: 'def456',
      },
      contextFiles: [],
      genealogy: {
        children: [],
      },
      tasks: [],
      message_count: 0,
      permission_config: { allowedTools: [] },
    };

    const sessionsRepo: Partial<SessionRepository> = {
      findById: vi.fn().mockResolvedValue(session),
      update: vi.fn().mockResolvedValue(session),
    };

    const messagesRepo: Partial<MessagesRepository> = {
      findBySessionId: vi.fn().mockResolvedValue([]),
    };

    const messagesService: Partial<MessagesService> & {
      patch?: (id: string, data: any) => Promise<any>;
    } = {
      create: vi.fn().mockResolvedValue({ message_id: messageId }),
      patch: vi.fn().mockResolvedValue({}),
    };

    const sessionsService: Partial<SessionsService> = {
      patch: vi.fn().mockResolvedValue(session),
    };

    const worktreesRepo: Partial<WorktreeRepository> = {
      findById: vi.fn(),
    };

    const result = {
      permissionService: (overrides?.permissionService ?? permissionService) as PermissionService,
      tasksService: (overrides?.tasksService ?? tasksService) as TasksService,
      sessionsRepo: (overrides?.sessionsRepo ?? sessionsRepo) as SessionRepository,
      messagesRepo: (overrides?.messagesRepo ?? messagesRepo) as MessagesRepository,
      messagesService: (overrides?.messagesService ?? messagesService) as
        | MessagesService
        | undefined,
      sessionsService: (overrides?.sessionsService ?? sessionsService) as
        | SessionsService
        | undefined,
      worktreesRepo: (overrides?.worktreesRepo ?? worktreesRepo) as WorktreeRepository | undefined,
      permissionLocks,
      session: overrides?.session ?? session,
    };
    return result;
  }

  // Helper to create PreToolUse input
  function createToolInput(
    toolName = 'Bash',
    toolInput: unknown = { command: 'ls' }
  ): PreToolUseHookInput {
    return {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      transcript_path: '/tmp/transcript.txt',
      cwd: '/tmp',
      tool_name: toolName,
      tool_input: toolInput,
    };
  }

  // Helper to create AbortSignal
  function createAbortSignal(): AbortSignal {
    const controller = new AbortController();
    return controller.signal;
  }

  it('should allow tool if already in session allowedTools', async () => {
    const deps = createMockDeps();
    deps.session.permission_config = { allowedTools: ['Bash'] };

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    const result = await hook(input, 'tool-use-1', { signal });

    expect((result as any).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Allowed by session config',
    });
    expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
    expect(deps.messagesService?.create).not.toHaveBeenCalled();
  });

  it('should wait for existing permission lock before checking', async () => {
    const deps = createMockDeps();
    let lockResolved = false;
    const existingLock = new Promise<void>((resolve) => {
      setTimeout(() => {
        lockResolved = true;
        resolve();
      }, 10);
    });
    deps.permissionLocks.set(sessionId, existingLock);

    // After lock resolves, tool should be allowed
    deps.sessionsRepo.findById = vi.fn().mockImplementation(async () => {
      // After waiting for lock, return allowed tools
      await existingLock;
      return { ...deps.session, permission_config: { allowedTools: ['Bash'] } };
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    const result = await hook(input, 'tool-use-1', { signal });

    expect(lockResolved).toBe(true);
    expect((result as any).hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('should create permission request message when no permission exists', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash', { command: 'ls -la' });
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.messagesService?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: sessionId,
        task_id: taskId,
        type: 'permission_request',
        role: MessageRole.SYSTEM,
        content: expect.objectContaining({
          tool_name: 'Bash',
          tool_input: { command: 'ls -la' },
          tool_use_id: 'tool-use-1',
          status: PermissionStatus.PENDING,
        }),
      })
    );
  });

  it('should update task status to awaiting_permission', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.tasksService.patch).toHaveBeenCalledWith(taskId, {
      status: TaskStatus.AWAITING_PERMISSION,
    });
  });

  it('should emit permission request via service', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.permissionService.emitRequest).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        taskId,
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolUseID: 'tool-use-1',
      })
    );
  });

  it('should wait for decision from permission service', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.permissionService.waitForDecision).toHaveBeenCalledWith(
      expect.any(String),
      taskId,
      signal
    );
  });

  it('should return allow when user approves', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      reason: 'Approved by user',
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    const result = await hook(input, 'tool-use-1', { signal });

    expect((result as any).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Approved by user',
    });
  });

  it('should return deny when user denies', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: false,
      reason: 'Denied by user',
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    const result = await hook(input, 'tool-use-1', { signal });

    expect((result as any).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Denied by user',
    });
  });

  it('should update task status to running when approved', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.tasksService.patch).toHaveBeenCalledWith(taskId, {
      status: TaskStatus.RUNNING,
    });
  });

  it('should update task status to failed when denied', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: false,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.tasksService.patch).toHaveBeenCalledWith(taskId, {
      status: TaskStatus.FAILED,
    });
  });

  it('should update permission message with approval status', async () => {
    const deps = createMockDeps();
    const mockPatch = vi.fn().mockResolvedValue({});
    (deps.messagesService as any).patch = mockPatch;

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(mockPatch).toHaveBeenCalledWith(
      expect.any(String), // MessageID is generated
      expect.objectContaining({
        content: expect.objectContaining({
          status: PermissionStatus.APPROVED,
          approved_by: 'user-1',
        }),
      })
    );
  });

  it('should save session-level permission when remember=true and scope=session', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: true,
      scope: PermissionScope.SESSION,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.sessionsService?.patch).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        permission_config: {
          allowedTools: ['Bash'],
        },
      })
    );
  });

  it('should merge with existing session-level permissions', async () => {
    const deps = createMockDeps();
    deps.session.permission_config = { allowedTools: ['Read'] };
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: true,
      scope: PermissionScope.SESSION,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.sessionsService?.patch).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        permission_config: {
          allowedTools: ['Read', 'Bash'],
        },
      })
    );
  });

  it('should use sessionsRepo if sessionsService not available', async () => {
    const deps = createMockDeps();
    deps.sessionsService = undefined;
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: true,
      scope: PermissionScope.SESSION,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.sessionsRepo.update).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        permission_config: {
          allowedTools: ['Bash'],
        },
      })
    );
  });

  it('should save project-level permission when remember=true and scope=project', async () => {
    const deps = createMockDeps();
    const worktreeId = generateId() as WorktreeID;
    deps.session.worktree_id = worktreeId;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
    const worktree: Worktree = {
      worktree_id: worktreeId as WorktreeID,
      repo_id: generateId() as UUID,
      worktree_unique_id: 1,
      name: 'test-worktree',
      path: tmpDir,
      ref: 'main',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: generateId() as UUID,
      new_branch: false,
      last_used: new Date().toISOString(),
    };

    (deps.worktreesRepo?.findById as ReturnType<typeof vi.fn>).mockResolvedValue(worktree);
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: true,
      scope: PermissionScope.PROJECT,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    // Verify settings file was created
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    expect(settings.permissions.allow.tools).toContain('Bash');

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should not save permission when remember=false', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.sessionsService?.patch).not.toHaveBeenCalled();
    expect(deps.sessionsRepo.update).not.toHaveBeenCalled();
  });

  it('should release permission lock after completion', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.permissionLocks.has(sessionId)).toBe(false);
  });

  it('should release permission lock even on error', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Test error')
    );

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.permissionLocks.has(sessionId)).toBe(false);
  });

  it('should update task status to failed on error', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Test error')
    );

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.tasksService.patch).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        status: TaskStatus.FAILED,
        report: expect.stringContaining('Test error'),
      })
    );
  });

  it('should return deny on error', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Test error')
    );

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    const result = await hook(input, 'tool-use-1', { signal });

    expect((result as any).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('Permission hook failed'),
    });
  });

  it('should handle error when messagesService create fails', async () => {
    const deps = createMockDeps();
    (deps.messagesService?.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Create failed')
    );

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    const result = await hook(input, 'tool-use-1', { signal });

    expect((result as any).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(deps.permissionLocks.has(sessionId)).toBe(false);
  });

  it('should handle error when tasksService patch fails', async () => {
    const deps = createMockDeps();
    (deps.tasksService.patch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Patch failed')
    );

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    const result = await hook(input, 'tool-use-1', { signal });

    expect((result as any).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(deps.permissionLocks.has(sessionId)).toBe(false);
  });

  it('should not throw when updating task status fails during error handling', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Test error')
    );
    (deps.tasksService.patch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Update failed')
    );

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    // Should not throw, should return deny
    const result = await hook(input, 'tool-use-1', { signal });
    expect((result as any).hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('should re-fetch session after waiting for lock', async () => {
    const deps = createMockDeps();
    const existingLock = Promise.resolve();
    deps.permissionLocks.set(sessionId, existingLock);

    let callCount = 0;
    deps.sessionsRepo.findById = vi.fn().mockImplementation(async () => {
      callCount++;
      // First call: after waiting for lock, still no permission
      // Second call: not needed because tool gets allowed on first check
      return {
        ...deps.session,
        permission_config: { allowedTools: callCount === 1 ? [] : ['Bash'] },
      };
    });

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    // Should be called once after waiting for lock, then goes through permission flow
    expect(deps.sessionsRepo.findById).toHaveBeenCalled();
  });

  it('should re-fetch session before persisting permission', async () => {
    const deps = createMockDeps();
    let callCount = 0;
    deps.sessionsRepo.findById = vi.fn().mockImplementation(() => {
      callCount++;
      // Return different data on each call to verify re-fetch
      return Promise.resolve({
        ...deps.session,
        permission_config: { allowedTools: callCount === 1 ? [] : ['Read'] },
      });
    });

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: true,
      scope: PermissionScope.SESSION,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    // Should merge with fresh data from second fetch
    expect(deps.sessionsService?.patch).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        permission_config: {
          allowedTools: ['Read', 'Bash'],
        },
      })
    );
  });

  it('should handle session not found when persisting permission', async () => {
    const deps = createMockDeps();
    (deps.sessionsRepo.findById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(deps.session)
      .mockResolvedValueOnce(null);

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: true,
      scope: PermissionScope.SESSION,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    const result = await hook(input, 'tool-use-1', { signal });

    expect((result as any).hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(deps.sessionsService?.patch).not.toHaveBeenCalled();
  });

  it('should handle worktree not found when persisting project permission', async () => {
    const deps = createMockDeps();
    const worktreeId = generateId() as WorktreeID;
    deps.session.worktree_id = worktreeId;
    (deps.worktreesRepo?.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: true,
      scope: PermissionScope.PROJECT,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    // Should complete without error
    const result = await hook(input, 'tool-use-1', { signal });
    expect((result as any).hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('should create new lock when no existing lock', async () => {
    const deps = createMockDeps();
    expect(deps.permissionLocks.has(sessionId)).toBe(false);

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // Verify lock exists during wait
      expect(deps.permissionLocks.has(sessionId)).toBe(true);
      return Promise.resolve({
        requestId: 'req-1',
        taskId,
        allow: true,
        remember: false,
        scope: PermissionScope.ONCE,
        decidedBy: 'user-1',
      });
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    // Lock should be released after completion
    expect(deps.permissionLocks.has(sessionId)).toBe(false);
  });

  it('should set correct message index based on existing messages', async () => {
    const deps = createMockDeps();
    const existingMessages: Message[] = [
      { message_id: generateId() as MessageID, index: 0 } as Message,
      { message_id: generateId() as MessageID, index: 1 } as Message,
      { message_id: generateId() as MessageID, index: 2 } as Message,
    ];
    (deps.messagesRepo.findBySessionId as ReturnType<typeof vi.fn>).mockResolvedValue(
      existingMessages
    );

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.messagesService?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 3, // Should be existingMessages.length
      })
    );
  });

  it('should handle non-Error exceptions', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockRejectedValue(
      'string error'
    );

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    const result = await hook(input, 'tool-use-1', { signal });

    expect((result as any).hookSpecificOutput?.permissionDecisionReason).toContain('string error');
    expect(deps.tasksService.patch).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        report: expect.stringContaining('string error'),
      })
    );
  });

  it('should handle complex tool input', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const complexInput = {
      file_path: '/path/to/file',
      old_string: 'old',
      new_string: 'new',
      metadata: { nested: { object: true } },
    };
    const input = createToolInput('Edit', complexInput);
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(deps.messagesService?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          tool_input: complexInput,
        }),
      })
    );
  });

  it('should update permission message with denial status', async () => {
    const deps = createMockDeps();
    const mockPatch = vi.fn().mockResolvedValue({});
    (deps.messagesService as any).patch = mockPatch;

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: false,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    expect(mockPatch).toHaveBeenCalledWith(
      expect.any(String), // MessageID is generated
      expect.objectContaining({
        content: expect.objectContaining({
          status: PermissionStatus.DENIED,
        }),
      })
    );
  });

  it('should not set scope in message when remember=false', async () => {
    const deps = createMockDeps();
    const mockPatch = vi.fn().mockResolvedValue({});
    (deps.messagesService as any).patch = mockPatch;

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    const patchCall = mockPatch.mock.calls[0][1];
    expect(patchCall.content.scope).toBeUndefined();
  });

  it('should set scope in message when remember=true', async () => {
    const deps = createMockDeps();
    const mockPatch = vi.fn().mockResolvedValue({});
    (deps.messagesService as any).patch = mockPatch;

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: true,
      scope: PermissionScope.SESSION,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, 'tool-use-1', { signal });

    const patchCall = mockPatch.mock.calls[0][1];
    expect(patchCall.content.scope).toBe(PermissionScope.SESSION);
  });

  it('should handle missing toolUseID', async () => {
    const deps = createMockDeps();
    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    await hook(input, undefined, { signal });

    expect(deps.messagesService?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          tool_use_id: undefined,
        }),
      })
    );
  });

  it('should handle session without worktree_id for project permission', async () => {
    const deps = createMockDeps();
    (deps.session as any).worktree_id = undefined;

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: true,
      scope: PermissionScope.PROJECT,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    // Should complete without error
    const result = await hook(input, 'tool-use-1', { signal });
    expect((result as any).hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(deps.worktreesRepo?.findById).not.toHaveBeenCalled();
  });

  it('should handle missing worktreesRepo for project permission', async () => {
    const deps = createMockDeps();
    deps.worktreesRepo = undefined;
    deps.session.worktree_id = generateId() as WorktreeID;

    (deps.permissionService.waitForDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      requestId: 'req-1',
      taskId,
      allow: true,
      remember: true,
      scope: PermissionScope.PROJECT,
      decidedBy: 'user-1',
    });

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    // Should complete without error
    const result = await hook(input, 'tool-use-1', { signal });
    expect((result as any).hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('should work without messagesService (repo fallback)', async () => {
    const deps = createMockDeps();
    deps.messagesService = undefined;
    deps.session.permission_config = { allowedTools: ['Bash'] };

    const hook = createPreToolUseHook(sessionId, taskId, deps);
    const input = createToolInput('Bash');
    const signal = createAbortSignal();

    const result = await hook(input, 'tool-use-1', { signal });

    expect((result as any).hookSpecificOutput?.permissionDecision).toBe('allow');
  });
});
