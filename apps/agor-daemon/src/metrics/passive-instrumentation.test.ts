import { EventEmitter } from 'node:events';
import type { TaskDispatchClaimResult } from '@agor/core/db';
import type { HookContext, Task } from '@agor/core/types';
import type express from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { Application } from '../declarations.js';
import { createFeathersMetricsHook } from './feathers.js';
import { createHttpMetricsMiddleware, normalizedHttpRoute } from './http.js';
import {
  recordDispatchClaim,
  recordExecutorConnected,
  recordTaskSettlement,
} from './task-lifecycle.js';
import type { DaemonMetrics, MetricTags } from './types.js';

class RecordingMetrics implements DaemonMetrics {
  readonly enabled = true;
  readonly calls: Array<{ type: string; name: string; value: number; tags?: MetricTags }> = [];

  increment(name: string, value = 1, tags?: MetricTags): void {
    this.calls.push({ type: 'increment', name, value, tags });
  }
  decrement(name: string, value = 1, tags?: MetricTags): void {
    this.calls.push({ type: 'decrement', name, value, tags });
  }
  gauge(name: string, value: number, tags?: MetricTags): void {
    this.calls.push({ type: 'gauge', name, value, tags });
  }
  histogram(name: string, value: number, tags?: MetricTags): void {
    this.calls.push({ type: 'histogram', name, value, tags });
  }
  timing(name: string, value: number, tags?: MetricTags): void {
    this.calls.push({ type: 'timing', name, value, tags });
  }
  distribution(name: string, value: number, tags?: MetricTags): void {
    this.calls.push({ type: 'distribution', name, value, tags });
  }
  startTimer(): () => number {
    return () => 0;
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('Feathers metrics hook', () => {
  it('counts and times only externally provided service calls', async () => {
    const metrics = new RecordingMetrics();
    const hook = createFeathersMetricsHook(metrics);
    const context = {
      path: 'sessions',
      method: 'find',
      params: { provider: 'socketio' },
    } as unknown as HookContext;
    await hook(context, async () => undefined);
    expect(metrics.calls).toHaveLength(2);
    expect(metrics.calls[0]).toMatchObject({
      type: 'increment',
      name: 'feathers.requests',
      tags: {
        service: 'sessions',
        method: 'find',
        transport: 'socketio',
        outcome: 'success',
        status_code: 'ok',
      },
    });
    expect(metrics.calls[1]?.value).toBeGreaterThanOrEqual(0);

    metrics.calls.length = 0;
    await hook(
      { path: 'sessions', method: 'get', params: {} } as unknown as HookContext,
      async () => undefined
    );
    expect(metrics.calls).toEqual([]);
  });

  it('records bounded error status and rethrows', async () => {
    const metrics = new RecordingMetrics();
    const hook = createFeathersMetricsHook(metrics);
    const failure = Object.assign(new Error('nope'), { code: 403 });
    await expect(
      hook(
        {
          path: 'branches',
          method: 'patch',
          params: { provider: 'rest' },
        } as unknown as HookContext,
        async () => {
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    expect(metrics.calls[0]?.tags).toMatchObject({ outcome: 'error', status_code: 403 });
  });

  it('skips excluded services and provider-preserving internal calls', async () => {
    const metrics = new RecordingMetrics();
    const internalParams = { provider: 'socketio', authenticationEntityLookup: true };
    const hook = createFeathersMetricsHook(metrics, {
      excludedServicePaths: ['health'],
      isInternalCall: (context) =>
        (context.params as typeof internalParams).authenticationEntityLookup === true,
    });
    const next = vi.fn(async () => undefined);

    await hook(
      { path: 'health', method: 'find', params: { provider: 'rest' } } as HookContext,
      next
    );
    await hook({ path: 'users', method: 'get', params: internalParams } as HookContext, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(metrics.calls).toEqual([]);
  });
});

describe('HTTP metrics middleware', () => {
  const app = { services: { sessions: {}, 'mcp-servers': {} } } as unknown as Application;

  it('uses Express or Feathers route templates and never a raw item id', () => {
    expect(
      normalizedHttpRoute(
        {
          path: '/sessions/0198d20e-7182-7000-8000-000000000000',
          route: undefined,
          baseUrl: '',
        } as unknown as express.Request,
        app
      )
    ).toBe('/sessions/:id');
    expect(
      normalizedHttpRoute(
        {
          path: '/widgets/private-value/submit',
          route: { path: '/widgets/:id/submit' },
          baseUrl: '',
        } as unknown as express.Request,
        app
      )
    ).toBe('/widgets/:id/submit');
    expect(
      normalizedHttpRoute(
        {
          path: '/arbitrary/private-value',
          route: undefined,
          baseUrl: '',
        } as unknown as express.Request,
        app
      )
    ).toBe('/_unmatched');
  });

  it('records final HTTP status, outcome, method, normalized route and duration', () => {
    const metrics = new RecordingMetrics();
    const middleware = createHttpMetricsMiddleware(app, metrics);
    const request = {
      method: 'GET',
      path: '/sessions/private-id',
      route: undefined,
      baseUrl: '',
    } as unknown as express.Request;
    const response = Object.assign(new EventEmitter(), {
      statusCode: 503,
      writableFinished: true,
    }) as unknown as express.Response;
    const next = vi.fn();
    middleware(request, response, next);
    response.emit('finish');
    response.emit('close');
    expect(next).toHaveBeenCalledOnce();
    expect(metrics.calls).toHaveLength(2);
    expect(metrics.calls[0]).toMatchObject({
      name: 'http.requests',
      tags: {
        method: 'GET',
        route: '/sessions/:id',
        status_code: 503,
        outcome: 'server_error',
      },
    });
    expect(metrics.calls[1]?.name).toBe('http.request.duration_ms');
    expect(metrics.calls[1]?.value).toBeGreaterThanOrEqual(0);
  });

  it('skips code-defined static path prefixes', () => {
    const metrics = new RecordingMetrics();
    const middleware = createHttpMetricsMiddleware(app, metrics, {
      excludedPathPrefixes: ['/app', '/static'],
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: true,
    }) as unknown as express.Response;
    middleware(
      { method: 'GET', path: '/app/assets/index.js' } as unknown as express.Request,
      response,
      vi.fn()
    );
    response.emit('finish');
    expect(metrics.calls).toEqual([]);
  });
});

describe('Task/executor lifecycle metrics', () => {
  const task = {
    task_id: 'never-emitted-task-id',
    session_id: 'never-emitted-session-id',
    status: 'completed',
    executor_mode: 'local',
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:02.000Z',
    executor_connected_at: '2026-01-01T00:00:05.000Z',
    completed_at: '2026-01-01T00:00:15.000Z',
  } as unknown as Task;

  it('uses persisted timestamps with explicitly bounded semantics', () => {
    const metrics = new RecordingMetrics();
    recordDispatchClaim(metrics, { outcome: 'claimed', task } as TaskDispatchClaimResult);
    recordExecutorConnected(metrics, task);
    recordTaskSettlement(metrics, task);
    expect(metrics.calls.map((call) => [call.name, call.value])).toEqual([
      ['executor.dispatches', 1],
      ['executor.request_to_dispatch.duration_ms', 2_000],
      ['executor.connections', 1],
      ['executor.dispatch_to_connected.duration_ms', 3_000],
      ['executor.request_to_connected.duration_ms', 5_000],
      ['task.settlements', 1],
      ['task.execution.duration_ms', 13_000],
      ['task.connected.duration_ms', 10_000],
    ]);
    expect(JSON.stringify(metrics.calls)).not.toContain('never-emitted');
    expect(metrics.calls.every((call) => !call.tags || !('task_id' in call.tags))).toBe(true);
  });

  it('does not manufacture a duration when a timestamp is unavailable', () => {
    const metrics = new RecordingMetrics();
    recordExecutorConnected(metrics, {
      ...task,
      executor_connected_at: undefined,
    });
    expect(metrics.calls.map((call) => call.name)).toEqual(['executor.connections']);
  });
});
