import { describe, expect, it, vi } from 'vitest';

const deleteWorker = vi.hoisted(() => vi.fn());
vi.mock('@agor/agentic-tool-opencode/runtime', () => ({
  deleteRetiredOpenCodeAttemptInWorker: deleteWorker,
}));

import { OpenCodeCleanupOperation } from './opencode-cleanup.js';

const layout = {
  homeDir: '/tmp/home',
  namespaceKey: 'a'.repeat(64),
  agorSessionId: '00000000-0000-4000-8000-000000000001',
  storeId: '00000000-0000-4000-8000-000000000002',
  attemptsDir: '/tmp/home/attempts',
  attemptTaskId: '00000000-0000-4000-8000-000000000003',
  scratchRoot: '/tmp/scratch',
  liveDbPath: '/tmp/scratch/opencode.db',
  xdg: { data: '/tmp/data', config: '/tmp/config', cache: '/tmp/cache', state: '/tmp/state' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function operationFor(service: object) {
  return new OpenCodeCleanupOperation(
    { service: () => service } as never,
    '00000000-0000-4000-8000-000000000004' as never,
    '00000000-0000-4000-8000-000000000005',
    layout
  );
}

describe('OpenCodeCleanupOperation', () => {
  it('dispatches one committed reservation even when the reservation reply is delayed', async () => {
    deleteWorker.mockReset();
    const service = {
      prepareCleanup: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 275));
        return { kind: 'observe' as const, attemptId: 'attempt' };
      }),
      observe: vi.fn().mockResolvedValue(undefined),
      acknowledgeDelete: vi.fn(),
    };
    const operation = operationFor(service);

    operation.start();
    await operation.stopAndDrain();

    expect(service.prepareCleanup).toHaveBeenCalledOnce();
    expect(service.observe).toHaveBeenCalledWith({
      task_id: '00000000-0000-4000-8000-000000000004',
      holder_instance_id: '00000000-0000-4000-8000-000000000005',
      attempt_id: 'attempt',
    });
    expect(deleteWorker).not.toHaveBeenCalled();
  });

  it('drains an already-reserved operation on Stop without reserving or issuing another', async () => {
    deleteWorker.mockReset();
    const reservation = deferred<{ kind: 'delete'; object: { storeId: string; taskId: string } }>();
    const deletion = deferred<{ outcome: 'deleted' }>();
    const service = {
      prepareCleanup: vi.fn(() => reservation.promise),
      observe: vi.fn(),
      acknowledgeDelete: vi.fn().mockResolvedValue(undefined),
    };
    deleteWorker.mockReturnValueOnce(deletion.promise);
    const operation = operationFor(service);
    operation.start();
    operation.start();
    await vi.waitFor(() => expect(service.prepareCleanup).toHaveBeenCalledOnce());

    let drained = false;
    const stopping = operation.stopAndDrain().then(() => {
      drained = true;
    });
    reservation.resolve({
      kind: 'delete',
      object: { storeId: layout.storeId, taskId: '00000000-0000-4000-8000-000000000006' },
    });
    await vi.waitFor(() => expect(deleteWorker).toHaveBeenCalledOnce());
    expect(drained).toBe(false);
    deletion.resolve({ outcome: 'deleted' });
    await stopping;

    operation.start();
    expect(drained).toBe(true);
    expect(service.prepareCleanup).toHaveBeenCalledOnce();
    expect(service.acknowledgeDelete).toHaveBeenCalledWith({
      task_id: '00000000-0000-4000-8000-000000000004',
      holder_instance_id: '00000000-0000-4000-8000-000000000005',
      object: { storeId: layout.storeId, taskId: '00000000-0000-4000-8000-000000000006' },
      result: { outcome: 'deleted' },
    });
  });

  it('refuses an object from another store without deleting or acknowledging it', async () => {
    deleteWorker.mockReset();
    const service = {
      prepareCleanup: vi.fn().mockResolvedValue({
        kind: 'delete' as const,
        object: {
          storeId: '00000000-0000-4000-8000-000000000007',
          taskId: '00000000-0000-4000-8000-000000000008',
        },
      }),
      observe: vi.fn(),
      acknowledgeDelete: vi.fn(),
    };
    const operation = operationFor(service);

    operation.start();
    await operation.stopAndDrain();

    expect(service.prepareCleanup).toHaveBeenCalledOnce();
    expect(deleteWorker).not.toHaveBeenCalled();
    expect(service.acknowledgeDelete).not.toHaveBeenCalled();
  });

  it('persists worker failure as retry state instead of acknowledging closure', async () => {
    deleteWorker.mockReset().mockResolvedValueOnce({
      outcome: 'failed',
      errorCode: 'WORKER_TIMEOUT',
    });
    const object = {
      storeId: layout.storeId,
      taskId: '00000000-0000-4000-8000-000000000009',
    };
    const service = {
      prepareCleanup: vi.fn().mockResolvedValue({ kind: 'delete' as const, object }),
      observe: vi.fn(),
      acknowledgeDelete: vi.fn().mockResolvedValue(undefined),
    };
    const operation = operationFor(service);

    expect(operation.start()).toBeUndefined();
    await operation.stopAndDrain();

    expect(deleteWorker).toHaveBeenCalledOnce();
    expect(service.acknowledgeDelete).toHaveBeenCalledWith({
      task_id: '00000000-0000-4000-8000-000000000004',
      holder_instance_id: '00000000-0000-4000-8000-000000000005',
      object,
      result: { outcome: 'failed', errorCode: 'WORKER_TIMEOUT' },
    });
  });
});
