import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client';
import type { UserID } from '../types';
import { withUserEnvironment } from './env-locking';
import * as resolverModule from './env-resolver';

// Mock the resolver
vi.mock('./env-resolver', () => ({
  resolveUserEnvironment: vi.fn(),
}));

describe('env-locking', () => {
  let mockDb: Partial<Database>;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    Object.assign(process.env, originalEnv);
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
  });

  describe('withUserEnvironment', () => {
    it('should execute function with augmented process.env', async () => {
      const userEnv = { GITHUB_TOKEN: 'token-123' };
      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue(userEnv);

      let envDuringExecution = {};
      const fn = async () => {
        envDuringExecution = { ...process.env };
        return 'success';
      };

      const result = await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      expect(result).toBe('success');
      expect(envDuringExecution.GITHUB_TOKEN).toBe('token-123');
    });

    it('should restore original process.env after execution', async () => {
      const originalToken = process.env.GITHUB_TOKEN;
      const userEnv = { GITHUB_TOKEN: 'user-token-override' };

      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue(userEnv);

      const fn = async () => {
        // Token should be augmented during execution
        expect(process.env.GITHUB_TOKEN).toBe('user-token-override');
        return 'success';
      };

      await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      // Token should be restored after execution
      expect(process.env.GITHUB_TOKEN).toBe(originalToken);
    });

    it('should remove added variables after execution', async () => {
      const userEnv = { NEW_VAR: 'added-by-user' };
      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue(userEnv);

      const fn = async () => {
        expect(process.env.NEW_VAR).toBe('added-by-user');
        return 'success';
      };

      delete process.env.NEW_VAR; // Make sure it's not there initially
      await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      // Variable added by user should be removed
      expect(process.env.NEW_VAR).toBeUndefined();
    });

    it('should handle function return value', async () => {
      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue({});

      const fn = async () => ({ result: 'data', count: 42 });

      const result = await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      expect(result).toEqual({ result: 'data', count: 42 });
    });

    it('should handle function throwing error', async () => {
      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue({});

      const error = new Error('Function failed');
      const fn = async () => {
        throw error;
      };

      await expect(withUserEnvironment('user-1' as UserID, mockDb as Database, fn)).rejects.toThrow(
        'Function failed'
      );
    });

    it('should restore env even when function throws', async () => {
      const userEnv = { TEST_VAR: 'test-value' };
      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue(userEnv);

      const fn = async () => {
        throw new Error('Test error');
      };

      try {
        await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);
      } catch (_e) {
        // Expected
      }

      // Should still restore env
      expect(process.env.TEST_VAR).toBeUndefined();
    });

    it('should prevent race conditions with multiple concurrent calls', async () => {
      const executionOrder: string[] = [];

      vi.mocked(resolverModule.resolveUserEnvironment)
        .mockResolvedValueOnce({ USER_ID: 'user-1-value' })
        .mockResolvedValueOnce({ USER_ID: 'user-2-value' });

      const fn1 = async () => {
        executionOrder.push('start-user1');
        // Simulate some async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionOrder.push('end-user1');
        expect(process.env.USER_ID).toBe('user-1-value');
      };

      const fn2 = async () => {
        executionOrder.push('start-user2');
        await new Promise((resolve) => setTimeout(resolve, 5));
        executionOrder.push('end-user2');
        expect(process.env.USER_ID).toBe('user-2-value');
      };

      // Execute both concurrently
      await Promise.all([
        withUserEnvironment('user-1' as UserID, mockDb as Database, fn1),
        withUserEnvironment('user-2' as UserID, mockDb as Database, fn2),
      ]);

      // Both should complete without interference
      expect(executionOrder).toContain('start-user1');
      expect(executionOrder).toContain('end-user1');
      expect(executionOrder).toContain('start-user2');
      expect(executionOrder).toContain('end-user2');
    });

    it('should handle sequential calls to same user', async () => {
      vi.mocked(resolverModule.resolveUserEnvironment)
        .mockResolvedValueOnce({ COUNTER: '1' })
        .mockResolvedValueOnce({ COUNTER: '2' });

      const fn1 = async () => {
        expect(process.env.COUNTER).toBe('1');
        return 'first';
      };

      const fn2 = async () => {
        expect(process.env.COUNTER).toBe('2');
        return 'second';
      };

      const result1 = await withUserEnvironment('user-1' as UserID, mockDb as Database, fn1);
      const result2 = await withUserEnvironment('user-1' as UserID, mockDb as Database, fn2);

      expect(result1).toBe('first');
      expect(result2).toBe('second');
    });

    it('should handle multiple variables in user environment', async () => {
      // Note: These would normally be encrypted in the database
      // For this test, we're just checking the cleanup mechanism works
      const userEnv = {
        UNIQUE_VAR_1: 'value-1',
        UNIQUE_VAR_2: 'value-2',
        UNIQUE_VAR_3: 'value-3',
      };

      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue(userEnv);

      const capturedEnv: Record<string, string | undefined> = {};
      const fn = async () => {
        Object.assign(capturedEnv, process.env);
      };

      await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      expect(capturedEnv.UNIQUE_VAR_1).toBe('value-1');
      expect(capturedEnv.UNIQUE_VAR_2).toBe('value-2');
      expect(capturedEnv.UNIQUE_VAR_3).toBe('value-3');

      // Should be cleaned up after function execution
      expect(process.env.UNIQUE_VAR_1).toBeUndefined();
      expect(process.env.UNIQUE_VAR_2).toBeUndefined();
      expect(process.env.UNIQUE_VAR_3).toBeUndefined();
    });

    it('should handle overriding existing system variables', async () => {
      process.env.SYSTEM_VAR = 'system-original';

      const userEnv = { SYSTEM_VAR: 'user-override' };
      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue(userEnv);

      const fn = async () => {
        expect(process.env.SYSTEM_VAR).toBe('user-override');
      };

      await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      // Should restore to original
      expect(process.env.SYSTEM_VAR).toBe('system-original');
    });

    it('should handle empty user environment', async () => {
      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue({});

      const fn = async () => 'success';

      const result = await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      expect(result).toBe('success');
    });

    it('should handle undefined values in user environment', async () => {
      const userEnv = {
        DEFINED_VAR: 'value',
        UNDEFINED_VAR: undefined as any,
      };

      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue(userEnv);

      const fn = async () => {
        expect(process.env.DEFINED_VAR).toBe('value');
      };

      await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      expect(process.env.DEFINED_VAR).toBeUndefined();
    });

    it('should call resolveUserEnvironment with correct parameters', async () => {
      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue({});

      const fn = async () => 'success';
      const userId = 'user-123' as UserID;

      await withUserEnvironment(userId, mockDb as Database, fn);

      expect(resolverModule.resolveUserEnvironment).toHaveBeenCalledWith(userId, mockDb);
    });

    it('should handle special characters in env values', async () => {
      const userEnv = {
        SPECIAL_VAR: 'value!@#$%^&*()_+-=[]{}|;:,.<>?/~`',
      };

      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue(userEnv);

      const fn = async () => {
        expect(process.env.SPECIAL_VAR).toBe(userEnv.SPECIAL_VAR);
      };

      await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      expect(process.env.SPECIAL_VAR).toBeUndefined();
    });

    it('should handle unicode characters in env values', async () => {
      const userEnv = {
        UNICODE_VAR: 'value-with-emoji-🎉-and-中文',
      };

      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue(userEnv);

      const fn = async () => {
        expect(process.env.UNICODE_VAR).toBe(userEnv.UNICODE_VAR);
      };

      await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      expect(process.env.UNICODE_VAR).toBeUndefined();
    });

    it('should support generic return types', async () => {
      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue({});

      const fn = async () => ({
        id: 1,
        name: 'test',
        nested: { value: 'deep' },
      });

      const result = await withUserEnvironment(
        'user-1' as UserID,
        mockDb as Database,
        fn as () => Promise<Record<string, any>>
      );

      expect(result.id).toBe(1);
      expect(result.name).toBe('test');
      expect(result.nested.value).toBe('deep');
    });

    it('should handle resolver returning mixed system + user vars', async () => {
      process.env.PATH = '/usr/bin';
      const userEnv = {
        PATH: '/custom/bin', // User overrides PATH (note: validation would block this, but locking doesn't care)
        CUSTOM_VAR: 'custom-value',
      };

      vi.mocked(resolverModule.resolveUserEnvironment).mockResolvedValue(userEnv);

      const originalPath = process.env.PATH;
      const fn = async () => {
        expect(process.env.PATH).toBe('/custom/bin');
        expect(process.env.CUSTOM_VAR).toBe('custom-value');
      };

      await withUserEnvironment('user-1' as UserID, mockDb as Database, fn);

      // Restoration
      expect(process.env.PATH).toBe(originalPath);
      expect(process.env.CUSTOM_VAR).toBeUndefined();
    });
  });

  describe('race condition prevention', () => {
    it('should serialize access for same user', async () => {
      const executionLog: string[] = [];

      vi.mocked(resolverModule.resolveUserEnvironment).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {};
      });

      const fn1 = async () => {
        executionLog.push('fn1-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionLog.push('fn1-end');
      };

      const fn2 = async () => {
        executionLog.push('fn2-start');
        executionLog.push('fn2-end');
      };

      // Queue two operations for same user
      const p1 = withUserEnvironment('user-1' as UserID, mockDb as Database, fn1);
      const p2 = withUserEnvironment('user-1' as UserID, mockDb as Database, fn2);

      await Promise.all([p1, p2]);

      // fn2 should wait for fn1 to complete (fn1-end before fn2-start)
      const fn1EndIdx = executionLog.indexOf('fn1-end');
      const fn2StartIdx = executionLog.indexOf('fn2-start');

      expect(fn1EndIdx).toBeLessThan(fn2StartIdx);
    });

    it('should allow parallel access for different users', async () => {
      const executionLog: string[] = [];

      vi.mocked(resolverModule.resolveUserEnvironment)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const fn = async (userId: string) => {
        executionLog.push(`${userId}-start`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionLog.push(`${userId}-end`);
      };

      await Promise.all([
        withUserEnvironment('user-1' as UserID, mockDb as Database, () => fn('user-1')),
        withUserEnvironment('user-2' as UserID, mockDb as Database, () => fn('user-2')),
      ]);

      // Both should run concurrently
      expect(executionLog).toContain('user-1-start');
      expect(executionLog).toContain('user-2-start');
      expect(executionLog).toContain('user-1-end');
      expect(executionLog).toContain('user-2-end');

      // Check that they overlap (interleaved execution)
      const _user1StartIdx = executionLog.indexOf('user-1-start');
      const user2StartIdx = executionLog.indexOf('user-2-start');
      const user1EndIdx = executionLog.indexOf('user-1-end');

      // user2 should start before user1 ends
      expect(user2StartIdx).toBeLessThan(user1EndIdx);
    });
  });
});
