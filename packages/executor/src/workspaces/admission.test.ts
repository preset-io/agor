import { expect, it } from 'vitest';
import { BranchAdmission } from './admission';

it('fences only the selected tenant and branch, and versions every accepted operation', () => {
  const gate = new BranchAdmission();
  const unlock = gate.lock('a', 'branch')!;
  expect(gate.enter('a', 'branch')).toBeUndefined();
  const other = gate.enter('b', 'branch')!;
  expect(other).toBeDefined();
  expect(gate.lock('b', 'branch')).toBeUndefined();
  other();
  unlock();
  const before = gate.version('a', 'branch');
  const done = gate.enter('a', 'branch')!;
  expect(gate.version('a', 'branch')).toBe(before + 1);
  expect(gate.lock('a', 'branch')).toBeUndefined();
  done();
  done();
  gate.lock('a', 'branch')!();
});

it('queues a capture-time request while unrelated branches proceed, and cancels cleanly', async () => {
  const gate = new BranchAdmission();
  const unlock = gate.lock('a', 'branch')!;
  let entered = false;
  const waiting = gate.enterWhenReady('a', 'branch', AbortSignal.timeout(1000)).then((leave) => {
    entered = true;
    return leave;
  });
  await Promise.resolve();
  expect(entered).toBe(false);
  const other = await gate.enterWhenReady('a', 'other', AbortSignal.timeout(1000));
  other();
  const stop = new AbortController();
  const cancelled = gate.enterWhenReady('a', 'branch', stop.signal);
  const rejection = expect(cancelled).rejects.toThrow('cancelled');
  stop.abort(new Error('cancelled'));
  await rejection;
  unlock();
  const leave = await waiting;
  expect(entered).toBe(true);
  expect(gate.lock('a', 'branch')).toBeUndefined();
  leave();
  const second = gate.lock('a', 'branch')!;
  unlock(); // An old unlock must not release a newer capture.
  expect(gate.enter('a', 'branch')).toBeUndefined();
  second();
});
