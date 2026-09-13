import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), heartbeat: vi.fn(), report: vi.fn() }));
vi.mock('../services/feathers-client.js', () => ({ createExecutorClient: mocks.connect }));
vi.mock('../executor-heartbeat.js', () => ({ startExecutorHeartbeat: mocks.heartbeat }));
vi.mock('../termination-report.js', () => ({ reportExecutorQuiescence: mocks.report }));

import { BranchAdmission } from './admission';
import { withWorkspacePreparation } from './preparation';

let task: any;
let service: any;
let close: any;
beforeEach(() => {
  vi.clearAllMocks();
  task = { task_id: 'task', status: 'running' };
  service = Object.assign(new EventEmitter(), {
    connectExecutor: vi.fn(async () => task),
    get: vi.fn(async () => task),
    patch: vi.fn(async () => task),
    reportTerminationComplete: vi.fn(async () => task),
  });
  close = vi.fn();
  mocks.connect.mockResolvedValue({ service: () => service, io: { close } });
  mocks.heartbeat.mockReturnValue({ stop: vi.fn(), recordPulse: vi.fn() });
  mocks.report.mockImplementation(async (o) => o.report());
});
it('claims the task and keeps startup alive until SDK handoff', async () => {
  await withWorkspacePreparation('url', 'token', 'task', async (_, handoff) => {
    expect(service.connectExecutor).toHaveBeenCalled();
    expect(mocks.heartbeat).toHaveBeenCalled();
    handoff();
    service.emit('termination_requested', {
      ...task,
      termination_request: { requested_at: 'now' },
    });
  });
  expect(mocks.report).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});
it('acknowledges Stop only after cancelled preparation has settled', async () => {
  let settled = false;
  await withWorkspacePreparation('url', 'token', 'task', async (signal) => {
    task = { ...task, status: 'stopping', termination_request: { requested_at: 'now' } };
    service.emit('termination_requested', task);
    expect(signal.aborted).toBe(true);
    expect(mocks.report).not.toHaveBeenCalled();
    settled = true;
    signal.throwIfAborted();
  });
  expect(settled).toBe(true);
  expect(service.reportTerminationComplete).toHaveBeenCalledWith({
    task_id: 'task',
    requested_at: 'now',
  });
});
it('publishes startup failures instead of leaving a spinner', async () => {
  await expect(
    withWorkspacePreparation('url', 'token', 'task', async () => {
      throw new Error('storage failed');
    })
  ).rejects.toThrow('storage failed');
  expect(service.patch).toHaveBeenCalledWith(
    'task',
    expect.objectContaining({
      status: 'failed',
      error_message: expect.stringContaining('storage failed'),
    })
  );
});

it('publishes and updates a visible system progress row, not an assistant response', async () => {
  const messages = {
    find: vi.fn(async () => ({ data: [{ index: 3 }] })),
    create: vi.fn(async (value) => value),
    patch: vi.fn(async () => ({})),
  };
  mocks.connect.mockResolvedValue({
    service: (name) => (name === 'messages' ? messages : service),
    io: { close },
  });
  await withWorkspacePreparation(
    'url',
    'token',
    'task',
    async (_, handoff, progress) => {
      handoff();
      await progress('Preparing branch files…');
      await progress('Workspace ready.');
    },
    'session'
  );
  expect(messages.create).toHaveBeenCalledTimes(1);
  expect(messages.create).toHaveBeenCalledWith(
    expect.objectContaining({
      role: 'system',
      index: 4,
      content: [{ type: 'sdk_event', text: 'Starting Claude…' }],
    })
  );
  expect(messages.patch).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ content: [{ type: 'sdk_event', text: 'Workspace ready.' }] })
  );
});

it('keeps a capture waiter supervised and settles Stop without admitting it', async () => {
  const gate = new BranchAdmission();
  const unlock = gate.lock('tenant', 'branch')!;
  await withWorkspacePreparation('url', 'token', 'task', async (signal) => {
    expect(mocks.heartbeat).toHaveBeenCalled();
    const waiting = gate.enterWhenReady('tenant', 'branch', signal);
    task = { ...task, status: 'stopping', termination_request: { requested_at: 'now' } };
    service.emit('termination_requested', task);
    await waiting;
    throw new Error('Stopped waiter was admitted');
  });
  expect(service.reportTerminationComplete).toHaveBeenCalled();
  unlock();
  expect(gate.lock('tenant', 'branch')).toBeDefined();
});
