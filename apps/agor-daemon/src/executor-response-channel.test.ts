import { createServer, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import {
  EXECUTOR_RESPONSE_CONTENT_TYPE,
  EXECUTOR_RESPONSE_PROTOCOL,
  EXECUTOR_RESPONSE_PROTOCOL_HEADER,
} from '@agor/core/executor-protocol';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeExecutorResponseCount,
  activeExecutorResponsePublisherCount,
  beginExecutorResponseDrain,
  configureExecutorResponseChannel,
  ExecutorResponseAdmissionError,
  registerExecutorResponseRoutes,
  reserveExecutorResponse,
} from './executor-response-channel.js';

let server: Server;
let origin: string;

function terminal(requestId: string, seq: number, result: unknown) {
  return JSON.stringify({
    v: 1,
    requestId,
    type: 'final',
    seq,
    result,
  });
}

function reserve(
  options: {
    onEvent?: (event: unknown) => void;
    timeoutMs?: number;
    profile?: 'terminal' | 'events';
    tenantId?: string;
  } = {}
) {
  return reserveExecutorResponse({
    tenantId: options.tenantId ?? 'tenant-a',
    command: 'branch.files.browse',
    branchId: 'branch-a',
    timeoutMs: options.timeoutMs ?? 1_000,
    timeoutResult: {
      success: false,
      error: { code: 'EXECUTOR_TIMEOUT', message: 'timed out' },
    },
    ...(options.profile ? { profile: options.profile } : {}),
    onEvent: options.onEvent,
  });
}

beforeEach(async () => {
  const app = express();
  registerExecutorResponseRoutes(app as never);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  origin = `http://127.0.0.1:${address.port}`;
  configureExecutorResponseChannel({
    originUrl: origin,
    maxResponseBytes: 1024,
    maxActiveRequests: 2,
  });
});

afterEach(async () => {
  beginExecutorResponseDrain();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('executor response receiver', () => {
  it('authenticates, delivers ordered events, and settles on final', async () => {
    const onEvent = vi.fn();
    const request = reserve({ onEvent, profile: 'events' });
    const body = [
      JSON.stringify({
        v: 1,
        requestId: request.descriptor.requestId,
        type: 'event',
        seq: 0,
        name: 'authorized',
        data: { authorization: { url: 'https://example.test', method: 'auto', instructions: '' } },
      }),
      terminal(request.descriptor.requestId, 1, { success: true, data: { files: ['é.ts'] } }),
      '',
    ].join('\n');
    const response = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body,
    });

    expect(response.status).toBe(204);
    await expect(request.result).resolves.toEqual({
      success: true,
      data: { files: ['é.ts'] },
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: 'authorized',
      authorization: { url: 'https://example.test', method: 'auto', instructions: '' },
    });
    expect(activeExecutorResponseCount()).toBe(0);
  });

  it('returns a uniform 404 for a wrong capability without consuming the request', async () => {
    const request = reserve();
    const wrong = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-capability-that-is-long-enough',
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body: `${terminal(request.descriptor.requestId, 0, { success: true })}\n`,
    });
    expect(wrong.status).toBe(404);
    expect(activeExecutorResponseCount()).toBe(1);

    const valid = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body: `${terminal(request.descriptor.requestId, 0, { success: true })}\n`,
    });
    expect(valid.status).toBe(204);
    await expect(request.result).resolves.toEqual({ success: true });
  });

  it('fails closed when the version header is absent', async () => {
    const request = reserve();
    const response = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
      },
      body: `${terminal(request.descriptor.requestId, 0, { success: true })}\n`,
    });

    expect(response.status).toBe(400);
    await expect(request.result).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_RESPONSE_INVALID' },
    });
  });

  it('does not let another reservation capability cross-submit a response', async () => {
    const tenantA = reserve({ tenantId: 'tenant-a' });
    const tenantB = reserve({ tenantId: 'tenant-b' });
    const crossed = await fetch(tenantA.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tenantB.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body: `${terminal(tenantA.descriptor.requestId, 0, { success: true })}\n`,
    });
    expect(crossed.status).toBe(404);

    tenantA.fail({ success: false, error: { code: 'CANCELLED', message: 'test cleanup' } });
    tenantB.fail({ success: false, error: { code: 'CANCELLED', message: 'test cleanup' } });
    await Promise.all([tenantA.result, tenantB.result]);
  });

  it('rejects out-of-order frames and fails the waiter', async () => {
    const request = reserve();
    const response = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body: `${terminal(request.descriptor.requestId, 2, { success: true })}\n`,
    });
    expect(response.status).toBe(400);
    await expect(request.result).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_RESPONSE_INVALID' },
    });
  });

  it('rejects bytes after a final frame in the same upload', async () => {
    const request = reserve();
    const response = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body:
        `${terminal(request.descriptor.requestId, 0, { success: true })}\n` +
        `${terminal(request.descriptor.requestId, 1, { success: true })}\n`,
    });
    expect(response.status).toBe(400);
    await expect(request.result).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_RESPONSE_INVALID' },
    });
  });

  it('allows only one active publisher for a reservation', async () => {
    const request = reserve({ profile: 'events' });
    const body = new PassThrough();
    const firstResponse = fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body: body as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    body.write(
      `${JSON.stringify({
        v: 1,
        requestId: request.descriptor.requestId,
        type: 'event',
        seq: 0,
        name: 'callback-started',
        data: {},
      })}\n`
    );
    await vi.waitFor(() => expect(activeExecutorResponsePublisherCount()).toBe(1));

    const duplicate = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body: `${terminal(request.descriptor.requestId, 0, { success: true })}\n`,
    });
    expect(duplicate.status).toBe(409);

    body.end(`${terminal(request.descriptor.requestId, 1, { success: true })}\n`);
    expect((await firstResponse).status).toBe(204);
    await expect(request.result).resolves.toEqual({ success: true });
  });

  it('rejects invalid framing and consumes the authenticated reservation', async () => {
    const request = reserve();
    const response = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body: new Uint8Array([0xff, 0xfe, 0xfd]),
    });
    expect(response.status).toBe(400);
    await expect(request.result).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_RESPONSE_INVALID' },
    });

    const replay = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body: `${terminal(request.descriptor.requestId, 0, { success: true })}\n`,
    });
    expect(replay.status).toBe(404);
  });

  it('enforces the configured byte limit before parsing', async () => {
    configureExecutorResponseChannel({
      originUrl: origin,
      maxResponseBytes: 128,
      maxActiveRequests: 2,
    });
    const request = reserve();
    const response = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body: 'x'.repeat(129),
    });
    expect(response.status).toBe(413);
    await expect(request.result).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_RESPONSE_TOO_LARGE' },
    });
  });

  it('bounds admission and rejects late frames after timeout', async () => {
    const request = reserve({ timeoutMs: 10 });
    await expect(request.result).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_TIMEOUT' },
    });
    const response = await fetch(request.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.descriptor.token}`,
        'content-type': EXECUTOR_RESPONSE_CONTENT_TYPE,
        [EXECUTOR_RESPONSE_PROTOCOL_HEADER]: EXECUTOR_RESPONSE_PROTOCOL,
      },
      body: `${terminal(request.descriptor.requestId, 0, { success: true })}\n`,
    });
    expect(response.status).toBe(404);
  });

  it('bounds concurrent waiter state without queuing or retries', async () => {
    const first = reserve();
    const second = reserve();
    expect(() => reserve()).toThrow(ExecutorResponseAdmissionError);

    first.fail({
      success: false,
      error: { code: 'EXECUTOR_CANCELLED', message: 'cancelled' },
    });
    second.fail({
      success: false,
      error: { code: 'EXECUTOR_CANCELLED', message: 'cancelled' },
    });
    await Promise.all([first.result, second.result]);
    expect(activeExecutorResponseCount()).toBe(0);
  });
});
