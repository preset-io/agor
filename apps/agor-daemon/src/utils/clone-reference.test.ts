import type { AgorConfig } from '@agor/core/config';
import type { DeepReadonly } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { shouldUseCloneReferencePath } from './clone-reference';

const asConfig = (config: AgorConfig): DeepReadonly<AgorConfig> =>
  config as DeepReadonly<AgorConfig>;

describe('shouldUseCloneReferencePath', () => {
  it('borrows base objects by default', () => {
    // Every existing install has no branch_storage block at all. The
    // `--reference` disk win must survive this change untouched.
    expect(shouldUseCloneReferencePath(asConfig({}))).toBe(true);
    expect(shouldUseCloneReferencePath(asConfig({ execution: {} }))).toBe(true);
    expect(
      shouldUseCloneReferencePath(
        asConfig({ execution: { branch_storage: { default_mode: 'clone' } } })
      )
    ).toBe(true);
  });

  it('still borrows when the operator explicitly opts in', () => {
    expect(
      shouldUseCloneReferencePath(
        asConfig({ execution: { branch_storage: { borrow_base_objects: true } } })
      )
    ).toBe(true);
  });

  it('drops the borrow when borrow_base_objects is false', () => {
    // The escape hatch for deployments whose sessions run in a mount that
    // has no `repos/` directory: an alternates pointer into the daemon's
    // base clone would make every later git command in the branch fail with
    // "unable to normalize alternate object path".
    expect(
      shouldUseCloneReferencePath(
        asConfig({ execution: { branch_storage: { borrow_base_objects: false } } })
      )
    ).toBe(false);
  });

  it('drops the borrow when executors are declared to have no base repository', () => {
    // `base_repository: 'unavailable'` is the operator already asserting the
    // exact topology that breaks alternates — honour it without making them
    // also remember a second knob.
    expect(
      shouldUseCloneReferencePath(
        asConfig({ execution: { executor_storage: { base_repository: 'unavailable' } } })
      )
    ).toBe(false);
  });

  it('keeps borrowing for shared and replica-local base repositories', () => {
    // Both of these assert the base checkout IS reachable from executors,
    // so the alternates pointer resolves and the disk win is safe.
    for (const base_repository of ['shared', 'replica-local'] as const) {
      expect(
        shouldUseCloneReferencePath(
          asConfig({ execution: { executor_storage: { base_repository } } })
        )
      ).toBe(true);
    }
  });

  it('lets the explicit knob disable borrowing even on a shared base repository', () => {
    expect(
      shouldUseCloneReferencePath(
        asConfig({
          execution: {
            branch_storage: { borrow_base_objects: false },
            executor_storage: { base_repository: 'shared' },
          },
        })
      )
    ).toBe(false);
  });
});
