/**
 * Unit tests for AgorExecutor
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgorExecutor } from '../src';
import type { JSONRPCRequest, JSONRPCResponse } from '../src/types';

describe('AgorExecutor', () => {
  const socketPath = '/tmp/test-executor-main.sock';
  let executor: AgorExecutor;
  let client: net.Socket;

  beforeEach(async () => {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });

  afterEach(async () => {
    if (client) {
      client.destroy();
    }
    if (executor) {
      await executor.stop();
    }
  });

  it('should start and accept connections', async () => {
    executor = new AgorExecutor(socketPath);
    await executor.start();

    expect(fs.existsSync(socketPath)).toBe(true);

    await new Promise<void>((resolve, reject) => {
      client = net.createConnection(socketPath);
      client.on('connect', () => resolve());
      client.on('error', reject);
    });

    expect(client.readyState).toBe('open');
  });

  it('should handle ping method', async () => {
    executor = new AgorExecutor(socketPath);
    await executor.start();

    client = net.createConnection(socketPath);

    const response = await new Promise<JSONRPCResponse>((resolve, reject) => {
      client.on('data', (data) => {
        const message = JSON.parse(data.toString());
        resolve(message);
      });

      client.on('connect', () => {
        const request: JSONRPCRequest = {
          jsonrpc: '2.0',
          id: 'test-1',
          method: 'ping',
          params: {},
        };
        client.write(`${JSON.stringify(request)}\n`);
      });

      client.on('error', reject);
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('test-1');
    expect(response.result).toMatchObject({
      pong: true,
      timestamp: expect.any(Number),
    });
  });

  it('should return error for unknown method', async () => {
    executor = new AgorExecutor(socketPath);
    await executor.start();

    client = net.createConnection(socketPath);

    const response = await new Promise<JSONRPCResponse>((resolve, reject) => {
      client.on('data', (data) => {
        const message = JSON.parse(data.toString());
        resolve(message);
      });

      client.on('connect', () => {
        const request: JSONRPCRequest = {
          jsonrpc: '2.0',
          id: 'test-2',
          method: 'unknown_method',
          params: {},
        };
        client.write(`${JSON.stringify(request)}\n`);
      });

      client.on('error', reject);
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32601);
    expect(response.error!.message).toContain('Unknown method');
  });

  it('should handle multiple sequential requests', async () => {
    executor = new AgorExecutor(socketPath);
    await executor.start();

    client = net.createConnection(socketPath);

    const responses: JSONRPCResponse[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const message = JSON.parse(line);
          responses.push(message);
          if (responses.length === 3) {
            resolve();
          }
        }
      });

      client.on('connect', () => {
        // Send 3 ping requests
        for (let i = 0; i < 3; i++) {
          const request: JSONRPCRequest = {
            jsonrpc: '2.0',
            id: `ping-${i}`,
            method: 'ping',
            params: {},
          };
          client.write(`${JSON.stringify(request)}\n`);
        }
      });

      client.on('error', reject);
    });

    expect(responses).toHaveLength(3);
    expect(responses[0].id).toBe('ping-0');
    expect(responses[1].id).toBe('ping-1');
    expect(responses[2].id).toBe('ping-2');
  });
});
