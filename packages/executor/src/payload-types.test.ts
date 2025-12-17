/**
 * Tests for ExecutorPayload types and Zod schemas
 */

import { describe, expect, it } from 'vitest';
import {
  ExecutorPayloadSchema,
  GitClonePayloadSchema,
  GitWorktreeAddPayloadSchema,
  GitWorktreeRemovePayloadSchema,
  getSupportedCommands,
  isGitClonePayload,
  isGitWorktreeAddPayload,
  isGitWorktreeRemovePayload,
  isPromptPayload,
  isZellijAttachPayload,
  PromptPayloadSchema,
  parseExecutorPayload,
  ZellijAttachPayloadSchema,
} from './payload-types.js';

describe('PromptPayloadSchema', () => {
  it('should parse valid prompt payload', () => {
    const payload = {
      command: 'prompt',
      sessionToken: 'jwt-token-here',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        taskId: '550e8400-e29b-41d4-a716-446655440001',
        prompt: 'Hello, world!',
        tool: 'claude-code',
        cwd: '/home/user/project',
      },
    };

    const result = PromptPayloadSchema.parse(payload);
    expect(result.command).toBe('prompt');
    expect(result.sessionToken).toBe('jwt-token-here');
    expect(result.params.tool).toBe('claude-code');
  });

  it('should parse prompt payload with optional fields', () => {
    // Note: asUser is now handled at spawn time, not in payload
    const payload = {
      command: 'prompt',
      sessionToken: 'jwt-token-here',
      daemonUrl: 'http://localhost:4000',
      env: { ANTHROPIC_API_KEY: 'key' },
      dataHome: '/data/agor',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        taskId: '550e8400-e29b-41d4-a716-446655440001',
        prompt: 'Hello!',
        tool: 'gemini',
        permissionMode: 'auto',
        cwd: '/home/user/project',
      },
    };

    const result = PromptPayloadSchema.parse(payload);
    expect(result.daemonUrl).toBe('http://localhost:4000');
    expect(result.env?.ANTHROPIC_API_KEY).toBe('key');
    expect(result.dataHome).toBe('/data/agor');
    expect(result.params.permissionMode).toBe('auto');
  });

  it('should reject invalid tool type', () => {
    const payload = {
      command: 'prompt',
      sessionToken: 'jwt-token-here',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        taskId: '550e8400-e29b-41d4-a716-446655440001',
        prompt: 'Hello!',
        tool: 'invalid-tool',
        cwd: '/home/user/project',
      },
    };

    expect(() => PromptPayloadSchema.parse(payload)).toThrow();
  });

  it('should reject missing required fields', () => {
    const payload = {
      command: 'prompt',
      sessionToken: 'jwt-token-here',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        // missing taskId, prompt, tool, cwd
      },
    };

    expect(() => PromptPayloadSchema.parse(payload)).toThrow();
  });
});

describe('GitClonePayloadSchema', () => {
  it('should parse valid git.clone payload with HTTPS URL', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'https://github.com/user/repo.git',
        outputPath: '/data/agor/repos/github.com/user/repo.git',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.command).toBe('git.clone');
    expect(result.params.url).toBe('https://github.com/user/repo.git');
  });

  it('should parse git.clone with SSH URL', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'git@github.com:user/repo.git',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.url).toBe('git@github.com:user/repo.git');
  });

  it('should parse git.clone with local path', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: '/home/user/repos/my-repo',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.url).toBe('/home/user/repos/my-repo');
  });

  it('should parse git.clone with git:// protocol', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'git://github.com/user/repo.git',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.url).toBe('git://github.com/user/repo.git');
  });

  it('should parse git.clone with ssh:// protocol', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'ssh://git@github.com/user/repo.git',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.url).toBe('ssh://git@github.com/user/repo.git');
  });

  it('should parse git.clone with optional fields', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'https://github.com/user/repo.git',
        outputPath: '/data/agor/repos/github.com/user/repo.git',
        branch: 'main',
        bare: true,
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.branch).toBe('main');
    expect(result.params.bare).toBe(true);
  });

  it('should reject invalid URL format', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'not-a-valid-url',
      },
    };

    expect(() => GitClonePayloadSchema.parse(payload)).toThrow();
  });
});

describe('GitWorktreeAddPayloadSchema', () => {
  it('should parse valid git.worktree.add payload', () => {
    const payload = {
      command: 'git.worktree.add',
      sessionToken: 'jwt-token-here',
      params: {
        worktreeId: '550e8400-e29b-41d4-a716-446655440002',
        repoId: '550e8400-e29b-41d4-a716-446655440003',
        repoPath: '/data/agor/repos/github.com/user/repo.git',
        worktreeName: 'feature-x',
        worktreePath: '/data/agor/worktrees/user/repo/feature-x',
      },
    };

    const result = GitWorktreeAddPayloadSchema.parse(payload);
    expect(result.command).toBe('git.worktree.add');
    expect(result.params.worktreeName).toBe('feature-x');
    expect(result.params.worktreeId).toBe('550e8400-e29b-41d4-a716-446655440002');
  });

  it('should parse with branch creation options', () => {
    const payload = {
      command: 'git.worktree.add',
      sessionToken: 'jwt-token-here',
      params: {
        worktreeId: '550e8400-e29b-41d4-a716-446655440002',
        repoId: '550e8400-e29b-41d4-a716-446655440003',
        repoPath: '/data/agor/repos/github.com/user/repo.git',
        worktreeName: 'feature-x',
        worktreePath: '/data/agor/worktrees/user/repo/feature-x',
        branch: 'feature-x',
        sourceBranch: 'main',
        createBranch: true,
      },
    };

    const result = GitWorktreeAddPayloadSchema.parse(payload);
    expect(result.params.branch).toBe('feature-x');
    expect(result.params.sourceBranch).toBe('main');
    expect(result.params.createBranch).toBe(true);
  });
});

describe('GitWorktreeRemovePayloadSchema', () => {
  it('should parse valid git.worktree.remove payload', () => {
    const payload = {
      command: 'git.worktree.remove',
      sessionToken: 'jwt-token-here',
      params: {
        worktreeId: '550e8400-e29b-41d4-a716-446655440002',
        worktreePath: '/data/agor/worktrees/user/repo/feature-x',
      },
    };

    const result = GitWorktreeRemovePayloadSchema.parse(payload);
    expect(result.command).toBe('git.worktree.remove');
    expect(result.params.worktreePath).toBe('/data/agor/worktrees/user/repo/feature-x');
    expect(result.params.worktreeId).toBe('550e8400-e29b-41d4-a716-446655440002');
  });

  it('should parse with force option', () => {
    const payload = {
      command: 'git.worktree.remove',
      sessionToken: 'jwt-token-here',
      params: {
        worktreeId: '550e8400-e29b-41d4-a716-446655440002',
        worktreePath: '/data/agor/worktrees/user/repo/feature-x',
        force: true,
      },
    };

    const result = GitWorktreeRemovePayloadSchema.parse(payload);
    expect(result.params.force).toBe(true);
  });
});

describe('ZellijAttachPayloadSchema', () => {
  it('should parse valid zellij.attach payload', () => {
    const payload = {
      command: 'zellij.attach',
      sessionToken: 'jwt-token-here',
      params: {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        sessionName: 'agor-session-123',
        cwd: '/data/agor/worktrees/user/repo/feature-x',
      },
    };

    const result = ZellijAttachPayloadSchema.parse(payload);
    expect(result.command).toBe('zellij.attach');
    expect(result.params.sessionName).toBe('agor-session-123');
    expect(result.params.userId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should parse with optional fields', () => {
    const payload = {
      command: 'zellij.attach',
      sessionToken: 'jwt-token-here',
      params: {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        sessionName: 'agor-session-123',
        cwd: '/data/agor/worktrees/user/repo/feature-x',
        tabName: 'feature-x',
        cols: 120,
        rows: 30,
      },
    };

    const result = ZellijAttachPayloadSchema.parse(payload);
    expect(result.params.tabName).toBe('feature-x');
    expect(result.params.cols).toBe(120);
    expect(result.params.rows).toBe(30);
  });
});

describe('ExecutorPayloadSchema (discriminated union)', () => {
  it('should parse prompt command', () => {
    const payload = {
      command: 'prompt',
      sessionToken: 'jwt',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        taskId: '550e8400-e29b-41d4-a716-446655440001',
        prompt: 'Hello',
        tool: 'claude-code',
        cwd: '/home/user',
      },
    };

    const result = ExecutorPayloadSchema.parse(payload);
    expect(result.command).toBe('prompt');
  });

  it('should parse git.clone command', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt',
      params: {
        url: 'https://github.com/user/repo.git',
        outputPath: '/data/repos/repo.git',
      },
    };

    const result = ExecutorPayloadSchema.parse(payload);
    expect(result.command).toBe('git.clone');
  });

  it('should reject unknown command', () => {
    const payload = {
      command: 'unknown.command',
      sessionToken: 'jwt',
      params: {},
    };

    expect(() => ExecutorPayloadSchema.parse(payload)).toThrow();
  });
});

describe('parseExecutorPayload', () => {
  it('should parse valid JSON string', () => {
    const json = JSON.stringify({
      command: 'prompt',
      sessionToken: 'jwt',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        taskId: '550e8400-e29b-41d4-a716-446655440001',
        prompt: 'Hello',
        tool: 'claude-code',
        cwd: '/home/user',
      },
    });

    const result = parseExecutorPayload(json);
    expect(result.command).toBe('prompt');
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseExecutorPayload('not json')).toThrow();
  });

  it('should throw on invalid schema', () => {
    const json = JSON.stringify({
      command: 'prompt',
      // missing required fields
    });

    expect(() => parseExecutorPayload(json)).toThrow();
  });
});

describe('Type guards', () => {
  const promptPayload = {
    command: 'prompt' as const,
    sessionToken: 'jwt',
    params: {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      taskId: '550e8400-e29b-41d4-a716-446655440001',
      prompt: 'Hello',
      tool: 'claude-code' as const,
      cwd: '/home/user',
    },
  };

  const gitClonePayload = {
    command: 'git.clone' as const,
    sessionToken: 'jwt',
    params: {
      url: 'https://github.com/user/repo.git',
      outputPath: '/data/repos/repo.git',
    },
  };

  it('isPromptPayload should identify prompt payloads', () => {
    expect(isPromptPayload(promptPayload)).toBe(true);
    expect(isPromptPayload(gitClonePayload)).toBe(false);
  });

  it('isGitClonePayload should identify git.clone payloads', () => {
    expect(isGitClonePayload(gitClonePayload)).toBe(true);
    expect(isGitClonePayload(promptPayload)).toBe(false);
  });

  it('isGitWorktreeAddPayload should identify git.worktree.add payloads', () => {
    const payload = {
      command: 'git.worktree.add' as const,
      sessionToken: 'jwt',
      params: {
        worktreeId: '550e8400-e29b-41d4-a716-446655440002',
        repoId: '550e8400-e29b-41d4-a716-446655440003',
        repoPath: '/data/repos/repo.git',
        worktreeName: 'feature',
        worktreePath: '/data/worktrees/feature',
      },
    };
    expect(isGitWorktreeAddPayload(payload)).toBe(true);
    expect(isGitWorktreeAddPayload(promptPayload)).toBe(false);
  });

  it('isGitWorktreeRemovePayload should identify git.worktree.remove payloads', () => {
    const payload = {
      command: 'git.worktree.remove' as const,
      sessionToken: 'jwt',
      params: {
        worktreeId: '550e8400-e29b-41d4-a716-446655440002',
        worktreePath: '/data/worktrees/feature',
      },
    };
    expect(isGitWorktreeRemovePayload(payload)).toBe(true);
    expect(isGitWorktreeRemovePayload(promptPayload)).toBe(false);
  });

  it('isZellijAttachPayload should identify zellij.attach payloads', () => {
    const payload = {
      command: 'zellij.attach' as const,
      sessionToken: 'jwt',
      params: {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        sessionName: 'session-123',
        cwd: '/home/user',
      },
    };
    expect(isZellijAttachPayload(payload)).toBe(true);
    expect(isZellijAttachPayload(promptPayload)).toBe(false);
  });
});

describe('getSupportedCommands', () => {
  it('should return all supported commands', () => {
    const commands = getSupportedCommands();
    expect(commands).toContain('prompt');
    expect(commands).toContain('git.clone');
    expect(commands).toContain('git.worktree.add');
    expect(commands).toContain('git.worktree.remove');
    expect(commands).toContain('git.worktree.clean');
    expect(commands).toContain('unix.sync-worktree');
    expect(commands).toContain('unix.sync-repo');
    expect(commands).toContain('unix.sync-user');
    expect(commands).toContain('zellij.attach');
    expect(commands).toContain('zellij.tab');
    expect(commands.length).toBe(10);
  });
});
