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
