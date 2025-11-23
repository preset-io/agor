/**
 * Unit tests for ExecutorIPCServer
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutorIPCServer } from '../src/ipc-server';
import type { JSONRPCRequest, JSONRPCResponse } from '../src/types';

describe('ExecutorIPCServer', () => {
  const socketPath = '/tmp/test-executor.sock';
  let server: ExecutorIPCServer;
  let client: net.Socket;

  beforeEach(async () => {
    // Clean up any existing socket
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });

  afterEach(async () => {
    if (client) {
      client.destroy();
    }
    if (server) {
      await server.stop();
    }
  });

  it('should start and listen on Unix socket', async () => {
    server = new ExecutorIPCServer(socketPath, async () => {});
    await server.start();

    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('should accept client connection', async () => {
    server = new ExecutorIPCServer(socketPath, async () => {});
    await server.start();

    await new Promise<void>((resolve, reject) => {
      client = net.createConnection(socketPath);
      client.on('connect', () => resolve());
      client.on('error', reject);
    });

    expect(client.readyState).toBe('open');
  });

  it('should handle ping request and respond', async () => {
    server = new ExecutorIPCServer(socketPath, async (message, respond) => {
      if (message.method === 'ping') {
        respond.success({ pong: true, timestamp: Date.now() });
      }
    });
    await server.start();

    // Connect client
    client = net.createConnection(socketPath);

    const response = await new Promise<JSONRPCResponse>((resolve, reject) => {
      client.on('data', (data) => {
        const message = JSON.parse(data.toString());
        resolve(message);
      });

      client.on('connect', () => {
        const request: JSONRPCRequest = {
          jsonrpc: '2.0',
          id: '1',
          method: 'ping',
          params: {},
        };
        client.write(`${JSON.stringify(request)}\n`);
      });

      client.on('error', reject);
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('1');
    expect(response.result).toMatchObject({ pong: true });
  });

  it('should handle multiple newline-delimited messages', async () => {
    const receivedMessages: string[] = [];

    server = new ExecutorIPCServer(socketPath, async (message, respond) => {
      receivedMessages.push(message.method);
      respond.success({ ok: true });
    });
    await server.start();

    client = net.createConnection(socketPath);

    await new Promise<void>((resolve, reject) => {
      let responseCount = 0;

      client.on('data', () => {
        responseCount++;
        if (responseCount === 3) {
          resolve();
        }
      });

      client.on('connect', () => {
        // Send 3 messages in one write (newline-delimited)
        const messages = `${[
          JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'ping1', params: {} }),
          JSON.stringify({ jsonrpc: '2.0', id: '2', method: 'ping2', params: {} }),
          JSON.stringify({ jsonrpc: '2.0', id: '3', method: 'ping3', params: {} }),
        ].join('\n')}\n`;

        client.write(messages);
      });

      client.on('error', reject);
    });

    expect(receivedMessages).toEqual(['ping1', 'ping2', 'ping3']);
  });

  it('should handle errors in message handler', async () => {
    server = new ExecutorIPCServer(socketPath, async (message, respond) => {
      if (message.method === 'fail') {
        throw new Error('Handler error');
      }
    });
    await server.start();

    client = net.createConnection(socketPath);

    const response = await new Promise<JSONRPCResponse>((resolve, reject) => {
      client.on('data', (data) => {
        const message = JSON.parse(data.toString());
        resolve(message);
      });

      client.on('connect', () => {
        const request: JSONRPCRequest = {
          jsonrpc: '2.0',
          id: '1',
          method: 'fail',
          params: {},
        };
        client.write(`${JSON.stringify(request)}\n`);
      });

      client.on('error', reject);
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32603);
    expect(response.error!.message).toContain('Handler error');
  });

  it('should send notifications to client', async () => {
    server = new ExecutorIPCServer(socketPath, async () => {});
    await server.start();

    client = net.createConnection(socketPath);

    const notification = await new Promise<any>((resolve, reject) => {
      client.on('data', (data) => {
        const message = JSON.parse(data.toString());
        resolve(message);
      });

      client.on('connect', () => {
        // Trigger server to send notification
        setTimeout(() => {
          server.notify('test_event', { foo: 'bar' });
        }, 100);
      });

      client.on('error', reject);
    });

    expect(notification.jsonrpc).toBe('2.0');
    expect(notification.method).toBe('test_event');
    expect(notification.params).toEqual({ foo: 'bar' });
    expect(notification.id).toBeUndefined(); // Notifications don't have id
  });

  it('should clean up socket file on stop', async () => {
    server = new ExecutorIPCServer(socketPath, async () => {});
    await server.start();

    expect(fs.existsSync(socketPath)).toBe(true);

    await server.stop();

    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
