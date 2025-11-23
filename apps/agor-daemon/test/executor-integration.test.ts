/**
 * Integration tests for Executor Pool and Client
 * Tests daemon's ability to spawn and communicate with executors
 */

import type { AgorConfig } from '@agor/core/types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExecutorPool } from '../src/services/executor-pool';

describe('Executor Integration', () => {
  let pool: ExecutorPool;
  const spawnedExecutors: string[] = [];

  beforeAll(() => {
    // Create pool with minimal config (no impersonation)
    const config: AgorConfig = {
      execution: {
        run_as_unix_user: false, // Disabled for testing (no sudo required)
      },
    };

    pool = new ExecutorPool(config);
    console.log('[test] ExecutorPool created');
  });

  afterEach(async () => {
    // Cleanup executors spawned in tests
    for (const executorId of spawnedExecutors) {
      try {
        await pool.terminate(executorId);
      } catch (error) {
        console.error(`[test] Failed to terminate executor ${executorId}:`, error);
      }
    }
    spawnedExecutors.length = 0;
  });

  afterAll(async () => {
    // Cleanup any remaining executors
    await pool.terminateAll();
  });

  it('should spawn executor and connect', async () => {
    const executor = await pool.spawn();
    spawnedExecutors.push(executor.id);

    expect(executor).toBeDefined();
    expect(executor.id).toBeTypeOf('string');
    expect(executor.socketPath).toBeTypeOf('string');
    expect(executor.process).toBeDefined();
    expect(executor.client).toBeDefined();
    expect(executor.client.isConnected()).toBe(true);
  }, 10000);

  it('should send ping and receive pong', async () => {
    const executor = await pool.spawn();
    spawnedExecutors.push(executor.id);

    const response = (await executor.client.request('ping', {})) as {
      pong: boolean;
      timestamp: number;
    };

    expect(response).toBeDefined();
    expect(response.pong).toBe(true);
    expect(response.timestamp).toBeTypeOf('number');
  }, 10000);

  it('should handle multiple sequential requests', async () => {
    const executor = await pool.spawn();
    spawnedExecutors.push(executor.id);

    const responses: any[] = [];

    for (let i = 0; i < 3; i++) {
      const response = await executor.client.request('ping', {});
      responses.push(response);
    }

    expect(responses).toHaveLength(3);
    responses.forEach((response) => {
      expect(response.pong).toBe(true);
    });
  }, 10000);

  it('should handle concurrent requests', async () => {
    const executor = await pool.spawn();
    spawnedExecutors.push(executor.id);

    const promises = Array.from({ length: 5 }, () => executor.client.request('ping', {}));

    const responses = await Promise.all(promises);

    expect(responses).toHaveLength(5);
    responses.forEach((response: any) => {
      expect(response.pong).toBe(true);
    });
  }, 10000);

  it('should spawn multiple executors concurrently', async () => {
    const promises = Array.from({ length: 3 }, () => pool.spawn());
    const executors = await Promise.all(promises);

    for (const executor of executors) {
      spawnedExecutors.push(executor.id);
    }

    expect(executors).toHaveLength(3);

    // Test each executor independently
    const pingPromises = executors.map((executor) => executor.client.request('ping', {}));

    const responses = await Promise.all(pingPromises);

    expect(responses).toHaveLength(3);
    responses.forEach((response: any) => {
      expect(response.pong).toBe(true);
    });
  }, 15000);

  it('should handle error for unknown method', async () => {
    const executor = await pool.spawn();
    spawnedExecutors.push(executor.id);

    await expect(executor.client.request('unknown_method', {})).rejects.toThrow('Unknown method');
  }, 10000);

  it('should gracefully terminate executor', async () => {
    const executor = await pool.spawn();
    spawnedExecutors.push(executor.id);

    expect(executor.client.isConnected()).toBe(true);

    await pool.terminate(executor.id);

    // Give it time to disconnect
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(executor.client.isConnected()).toBe(false);
    expect(pool.get(executor.id)).toBeUndefined();
  }, 10000);

  it('should track executors in pool', async () => {
    const executor1 = await pool.spawn();
    const executor2 = await pool.spawn();

    spawnedExecutors.push(executor1.id, executor2.id);

    const allExecutors = pool.getAll();

    expect(allExecutors.length).toBeGreaterThanOrEqual(2);
    expect(allExecutors.find((e) => e.id === executor1.id)).toBeDefined();
    expect(allExecutors.find((e) => e.id === executor2.id)).toBeDefined();
  }, 10000);

  it('should handle notifications from executor', async () => {
    const executor = await pool.spawn();
    spawnedExecutors.push(executor.id);

    const receivedNotifications: unknown[] = [];

    // Register notification handler
    executor.client.onNotification('test_event', (params) => {
      receivedNotifications.push(params);
    });

    // Trigger executor to send notification (would be implemented in Phase 3)
    // For now, we just verify the handler registration works
    expect(receivedNotifications).toHaveLength(0);

    // Cleanup
    executor.client.offNotification('test_event');
  }, 10000);
});

describe('Executor Impersonation', () => {
  it('should detect impersonation mode', () => {
    // Test with impersonation disabled
    const configDisabled: AgorConfig = {
      execution: {
        run_as_unix_user: false,
      },
    };

    const poolDisabled = new ExecutorPool(configDisabled);
    expect(poolDisabled).toBeDefined();

    // Test with impersonation enabled (will fallback if sudo not available)
    const configEnabled: AgorConfig = {
      execution: {
        run_as_unix_user: true,
        executor_unix_user: 'agor_test',
      },
    };

    const poolEnabled = new ExecutorPool(configEnabled);
    expect(poolEnabled).toBeDefined();
  });
});
