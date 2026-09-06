import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EXECUTOR_RESPONSE_PROTOCOL,
  EXECUTOR_RESPONSE_PROTOCOL_HEADER,
  type ExecutorResponseDescriptor,
} from '@agor/core/executor-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutorResponsePublisher } from './executor-response.js';

let server: Server;
let received = '';
let responseStatus = 204;
let descriptor: ExecutorResponseDescriptor;
let authorization = '';
let protocolHeader = '';
let requestCount = 0;
let connectionCount = 0;

beforeEach(async () => {
  received = '';
  responseStatus = 204;
  authorization = '';
  protocolHeader = '';
  requestCount = 0;
  connectionCount = 0;
  server = createServer((request, response) => {
    requestCount += 1;
    authorization = String(request.headers.authorization ?? '');
    protocolHeader = String(request.headers[EXECUTOR_RESPONSE_PROTOCOL_HEADER] ?? '');
    request.on('data', (chunk) => {
      received += chunk.toString();
    });
    request.on('end', () => {
      response.statusCode = responseStatus;
      response.end();
    });
  });
  server.on('connection', () => {
    connectionCount += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  descriptor = {
    protocol: EXECUTOR_RESPONSE_PROTOCOL,
    profile: 'events',
    requestId: '550e8400-e29b-41d4-a716-446655440000',
    url: `http://127.0.0.1:${port}/internal/executor-responses/v1/test`,
    token: 'a'.repeat(43),
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    maxResponseBytes: 1024,
  };
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('ExecutorResponsePublisher', () => {
  it('does not open a terminal-only response request until the command finishes', async () => {
    descriptor.profile = 'terminal';
    const publisher = new ExecutorResponsePublisher(descriptor);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(connectionCount).toBe(0);
    expect(requestCount).toBe(0);

    await publisher.final({ success: true });
    expect(connectionCount).toBe(1);
    expect(requestCount).toBe(1);
  });

  it('survives a receiver header timeout shorter than a terminal command', async () => {
    const timeoutServer = createServer(
      { headersTimeout: 50, connectionsCheckingInterval: 10 },
      (request, response) => {
        request.resume();
        request.on('end', () => {
          response.statusCode = 204;
          response.end();
        });
      }
    );
    await new Promise<void>((resolve) => timeoutServer.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = timeoutServer.address() as AddressInfo;
      const publisher = new ExecutorResponsePublisher({
        ...descriptor,
        profile: 'terminal',
        url: `http://127.0.0.1:${port}/slow-terminal-command`,
      });

      // The old publisher opened its connection in the constructor. Node
      // answered that idle connection with 408 before the command completed.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(publisher.final({ success: true })).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => timeoutServer.close(() => resolve()));
    }
  });

  it('fails closed without connecting when the command misses its deadline', async () => {
    descriptor.profile = 'terminal';
    descriptor.deadlineAt = new Date(Date.now() + 20).toISOString();
    const publisher = new ExecutorResponsePublisher(descriptor);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(publisher.final({ success: true })).rejects.toThrow(/abort/i);
    expect(connectionCount).toBe(0);
    expect(requestCount).toBe(0);
  });

  it('sends ordered event/final NDJSON over one request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const publisher = new ExecutorResponsePublisher(descriptor);
    publisher.emit({ type: 'authorized' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    publisher.emit({ type: 'consumer.progress', completed: 1 });
    await publisher.final({ success: true, data: { ok: true } });

    expect(
      received
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      {
        v: 1,
        requestId: descriptor.requestId,
        type: 'event',
        seq: 0,
        name: 'authorized',
        data: {},
      },
      {
        v: 1,
        requestId: descriptor.requestId,
        type: 'event',
        seq: 1,
        name: 'consumer.progress',
        data: { completed: 1 },
      },
      {
        v: 1,
        requestId: descriptor.requestId,
        type: 'final',
        seq: 2,
        result: { success: true, data: { ok: true } },
      },
    ]);
    expect(authorization).toBe(`Bearer ${descriptor.token}`);
    expect(protocolHeader).toBe(EXECUTOR_RESPONSE_PROTOCOL);
    fetchSpy.mockRestore();
  });

  it('does not connect for a first event dropped to reserve the terminal frame', async () => {
    descriptor.maxResponseBytes = 512;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const publisher = new ExecutorResponsePublisher(descriptor);

    publisher.emit({ type: 'authorized' });
    expect(fetchSpy).not.toHaveBeenCalled();

    await publisher.final({ success: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(connectionCount).toBe(1);
    const frame = JSON.parse(received.trim()) as { result: { error?: { code?: string } } };
    expect(frame.result.error?.code).toBe('EXECUTOR_RESPONSE_TOO_LARGE');
    fetchSpy.mockRestore();
  });

  it('replaces an oversized terminal value with a typed bounded failure', async () => {
    descriptor.maxResponseBytes = 300;
    const publisher = new ExecutorResponsePublisher(descriptor);
    await publisher.final({ success: true, data: 'x'.repeat(1_000) });

    const frame = JSON.parse(received.trim()) as {
      result: { success: boolean; error: { code: string; details: { maxResponseBytes: number } } };
    };
    expect(frame.result).toEqual({
      success: false,
      error: {
        code: 'EXECUTOR_RESPONSE_TOO_LARGE',
        message: 'Executor response exceeds the configured 300-byte limit',
        details: { maxResponseBytes: 300 },
      },
    });
    expect(Buffer.byteLength(received)).toBeLessThanOrEqual(300);
  });

  it('accepts a terminal frame whose serialized body is exactly the limit', async () => {
    const result = { success: true, data: 'exact-boundary' };
    const expected = `${JSON.stringify({
      v: 1,
      requestId: descriptor.requestId,
      type: 'final',
      seq: 0,
      result,
    })}\n`;
    descriptor.maxResponseBytes = Buffer.byteLength(expected);

    const publisher = new ExecutorResponsePublisher(descriptor);
    await publisher.final(result);

    expect(received).toBe(expected);
  });

  it('rejects events from terminal-only request profiles', async () => {
    descriptor.profile = 'terminal';
    const publisher = new ExecutorResponsePublisher(descriptor);

    expect(() => publisher.emit({ type: 'authorized' })).toThrow(/does not allow events/i);
    await publisher.final({ success: true });
  });

  it('rejects malformed consumer-owned event names', async () => {
    const publisher = new ExecutorResponsePublisher(descriptor);

    expect(() => publisher.emit({ type: 'Not Namespaced' })).toThrow(/event name is invalid/i);
    await publisher.final({ success: true });
  });

  it('fails when the receiver does not acknowledge the terminal response', async () => {
    responseStatus = 404;
    const publisher = new ExecutorResponsePublisher(descriptor);
    await expect(publisher.final({ success: true })).rejects.toThrow(/rejected.*404/i);
  });
});
