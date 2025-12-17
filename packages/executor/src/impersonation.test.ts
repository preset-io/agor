/**
 * Tests for impersonation module
 */

import { describe, expect, it } from 'vitest';

import {
  checkImpersonation,
  IMPERSONATED_ENV_VAR,
  isImpersonated,
  isRunningAsUser,
} from './impersonation.js';
import type { ExecutorPayload } from './payload-types.js';

describe('impersonation', () => {
  describe('isImpersonated', () => {
    it('returns false when env var not set', () => {
      delete process.env[IMPERSONATED_ENV_VAR];
      expect(isImpersonated()).toBe(false);
    });

    it('returns false when env var is not "true"', () => {
      process.env[IMPERSONATED_ENV_VAR] = 'false';
      expect(isImpersonated()).toBe(false);
      delete process.env[IMPERSONATED_ENV_VAR];
    });

    it('returns true when env var is "true"', () => {
      process.env[IMPERSONATED_ENV_VAR] = 'true';
      expect(isImpersonated()).toBe(true);
      delete process.env[IMPERSONATED_ENV_VAR];
    });
  });

  describe('isRunningAsUser', () => {
    it('returns true when current user matches target', () => {
      // Get current user from os.userInfo()
      const os = require('os');
      const currentUser = os.userInfo().username;
      expect(isRunningAsUser(currentUser)).toBe(true);
    });

    it('returns false when current user does not match target', () => {
      expect(isRunningAsUser('nonexistent-test-user-12345')).toBe(false);
    });
  });

  describe('checkImpersonation', () => {
    const basePayload: ExecutorPayload = {
      command: 'prompt',
      sessionToken: 'test-token',
      params: {
        sessionId: '00000000-0000-0000-0000-000000000001',
        taskId: '00000000-0000-0000-0000-000000000002',
        prompt: 'test',
        tool: 'claude-code',
        cwd: '/tmp',
      },
    };

    it('returns needsImpersonation=false when no asUser specified', () => {
      const result = checkImpersonation(basePayload);
      expect(result.needsImpersonation).toBe(false);
      expect(result.reason).toContain('No asUser');
    });

    it('returns needsImpersonation=false when already impersonated', () => {
      process.env[IMPERSONATED_ENV_VAR] = 'true';
      const payload = { ...basePayload, asUser: 'someuser' };
      const result = checkImpersonation(payload);
      expect(result.needsImpersonation).toBe(false);
      expect(result.reason).toContain('Already impersonated');
      delete process.env[IMPERSONATED_ENV_VAR];
    });

    it('returns needsImpersonation=false when already running as target user', () => {
      const os = require('os');
      const currentUser = os.userInfo().username;
      const payload = { ...basePayload, asUser: currentUser };
      const result = checkImpersonation(payload);
      expect(result.needsImpersonation).toBe(false);
      expect(result.reason).toContain('Already running as target user');
    });

    it('returns needsImpersonation=true when impersonation is needed', () => {
      delete process.env[IMPERSONATED_ENV_VAR];
      const payload = { ...basePayload, asUser: 'some-other-user-12345' };
      const result = checkImpersonation(payload);
      expect(result.needsImpersonation).toBe(true);
      expect(result.targetUser).toBe('some-other-user-12345');
      expect(result.reason).toContain('Need to impersonate');
    });
  });

  describe('checkImpersonation with different payload types', () => {
    it('works with git.clone payload', () => {
      const payload: ExecutorPayload = {
        command: 'git.clone',
        sessionToken: 'test-token',
        asUser: 'some-user-12345',
        params: {
          url: 'https://github.com/test/repo',
          outputPath: '/tmp/repo',
        },
      };
      const result = checkImpersonation(payload);
      expect(result.needsImpersonation).toBe(true);
      expect(result.targetUser).toBe('some-user-12345');
    });

    it('works with git.worktree.add payload', () => {
      const payload: ExecutorPayload = {
        command: 'git.worktree.add',
        sessionToken: 'test-token',
        asUser: 'another-user-67890',
        params: {
          repoPath: '/tmp/repo.git',
          worktreeName: 'feature-branch',
          worktreePath: '/tmp/worktrees/feature-branch',
        },
      };
      const result = checkImpersonation(payload);
      expect(result.needsImpersonation).toBe(true);
      expect(result.targetUser).toBe('another-user-67890');
    });

    it('works with zellij.attach payload', () => {
      const payload: ExecutorPayload = {
        command: 'zellij.attach',
        sessionToken: 'test-token',
        params: {
          sessionName: 'agor-test',
          cwd: '/tmp',
        },
      };
      // No asUser specified
      const result = checkImpersonation(payload);
      expect(result.needsImpersonation).toBe(false);
    });
  });
});
