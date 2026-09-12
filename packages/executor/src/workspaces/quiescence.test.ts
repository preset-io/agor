import { expect, it } from 'vitest';
import { isQuiescentSdkTree, SDK_PROCESS_COLUMNS } from './quiescence';

it('requires a PID-aware listing with exactly init and its executor child', () => {
  expect(SDK_PROCESS_COLUMNS).toBe('pid,ppid,comm');
  const listing = 'PID PPID COMMAND\n100 99 docker-init\n101 100 node\n';
  expect(isQuiescentSdkTree(0, listing)).toBe(true);
  expect(isQuiescentSdkTree(1, listing)).toBe(false);
  expect(isQuiescentSdkTree(0, `${listing}102 101 claude\n`)).toBe(false);
  expect(isQuiescentSdkTree(0, listing.replace('101 100', '101 99'))).toBe(false);
  expect(isQuiescentSdkTree(0, 'COMMAND\ndocker-init\nnode')).toBe(false);
});
