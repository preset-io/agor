import type { AgorConfig } from '@agor/core/config';
import type { DeepReadonly } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { resolveBranchStorageHealthConfig, shouldUseCloneReferencePath } from './clone-reference';

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

  describe('public health facts', () => {
    it('preserves resolved fields and reports the effective default borrow decision', () => {
      expect(resolveBranchStorageHealthConfig({})).toEqual({
        defaultMode: 'worktree',
        allowedModes: ['worktree', 'clone'],
        allowShallowClones: true,
        borrowBaseObjects: true,
      });
    });

    it('reports the same effective non-borrowing decision as branch creation', () => {
      const config = {
        execution: {
          sandbox: { enabled: true, home_mode: 'per_user' as const },
          branch_storage: { borrow_base_objects: true as const },
        },
      };
      expect(resolveBranchStorageHealthConfig(config)).toMatchObject({
        allowShallowClones: true,
        borrowBaseObjects: true,
      });
      expect(
        resolveBranchStorageHealthConfig({
          execution: { sandbox: { enabled: true, home_mode: 'per_user' } },
        })
      ).toMatchObject({ borrowBaseObjects: false });
    });

    it('contains no path or raw configuration detail', () => {
      const health = resolveBranchStorageHealthConfig({
        execution: {
          branch_storage: { borrow_base_objects: false },
          executor_storage: { base_repository: 'unavailable' },
        },
      });
      expect(health).toEqual({
        defaultMode: 'worktree',
        allowedModes: ['worktree', 'clone'],
        allowShallowClones: true,
        borrowBaseObjects: false,
      });
      expect(JSON.stringify(health)).not.toMatch(/borrow_base_objects|repos|secret|config/i);
    });
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

  it('lets base_repository: unavailable outrank an explicit opt-in', () => {
    // Nothing an operator writes here can make a base checkout they have
    // declared absent appear inside an executor, so the assertion wins.
    expect(
      shouldUseCloneReferencePath(
        asConfig({
          execution: {
            branch_storage: { borrow_base_objects: true },
            executor_storage: { base_repository: 'unavailable' },
          },
        })
      )
    ).toBe(false);
  });

  it('keeps borrowing for shared and replica-local base repositories', () => {
    // `shared` asserts the base checkout is reachable from executors.
    // `replica-local` only asserts it sits on the replica's own disk — under
    // `execution_topology: external` that is NOT a reachability claim, so it
    // is treated as "no signal" (borrow preserved) rather than as proof the
    // borrow is safe. Operators in that shape use the explicit knob.
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

  // ── the regression `915c8b1cd` introduced and `0a077e6c2` cemented ────────
  //
  // `git.branch.add` is a daemon-internal executor spawn and is never
  // sandbox-wrapped, so its `existsSync(referencePath)` probe passes and the
  // alternates pointer is written. The `prompt` / `zellij.attach` spawns that
  // later run git inside that branch ARE wrapped, and the `per_user` overlay
  // masks the whole daemon `.agor` tree — `repos/` included. Every git command
  // in the branch then dies on "unable to normalize alternate object path".
  describe('executor sandbox', () => {
    const sandboxed = (
      sandbox: NonNullable<NonNullable<AgorConfig['execution']>['sandbox']>,
      branch_storage?: NonNullable<AgorConfig['execution']>['branch_storage']
    ): DeepReadonly<AgorConfig> =>
      asConfig({ execution: { sandbox, ...(branch_storage ? { branch_storage } : {}) } });

    it('drops the borrow under a per_user sandbox home', () => {
      expect(shouldUseCloneReferencePath(sandboxed({ enabled: true, home_mode: 'per_user' }))).toBe(
        false
      );
    });

    it('keeps borrowing under a shared sandbox home', () => {
      // Shared mode keeps bubblewrap's `--ro-bind / /`, so `<data_home>/repos`
      // is still readable and the alternates pointer resolves.
      expect(shouldUseCloneReferencePath(sandboxed({ enabled: true, home_mode: 'shared' }))).toBe(
        true
      );
      // `shared` is also the default when home_mode is omitted.
      expect(shouldUseCloneReferencePath(sandboxed({ enabled: true }))).toBe(true);
    });

    it('drops the borrow for the unix_user_mode: sandbox named mode', () => {
      // `loadConfig` folds this mode into `{ enabled: true, home_mode:
      // 'per_user', fail_if_unavailable: true }`, so the effective config the
      // daemon holds is already covered by the case above. A daemon started
      // with a caller-supplied `DaemonStartOptions.config` skips that
      // projection, so key off the named mode directly too.
      expect(
        shouldUseCloneReferencePath(asConfig({ execution: { unix_user_mode: 'sandbox' } }))
      ).toBe(false);
      expect(
        shouldUseCloneReferencePath(
          asConfig({
            execution: {
              unix_user_mode: 'sandbox',
              sandbox: { enabled: true, home_mode: 'per_user' },
            },
          })
        )
      ).toBe(false);
    });

    it('keeps borrowing for non-sandbox unix user modes', () => {
      for (const unix_user_mode of ['simple', 'delegated'] as const) {
        expect(shouldUseCloneReferencePath(asConfig({ execution: { unix_user_mode } }))).toBe(true);
      }
    });

    it('ignores a per_user home when the sandbox is not enabled', () => {
      expect(shouldUseCloneReferencePath(sandboxed({ home_mode: 'per_user' }))).toBe(true);
      expect(
        shouldUseCloneReferencePath(sandboxed({ enabled: false, home_mode: 'per_user' }))
      ).toBe(true);
    });

    it('lets an explicit opt-in override the per_user inference', () => {
      // The operator can make the base clone reachable inside the sandbox
      // (`execution.sandbox.extra_allow_write`), so an explicit `true` is
      // honoured rather than silently ignored.
      expect(
        shouldUseCloneReferencePath(
          sandboxed({ enabled: true, home_mode: 'per_user' }, { borrow_base_objects: true })
        )
      ).toBe(true);
    });

    it('keeps an explicit opt-out under a shared sandbox home', () => {
      expect(
        shouldUseCloneReferencePath(
          sandboxed({ enabled: true, home_mode: 'shared' }, { borrow_base_objects: false })
        )
      ).toBe(false);
    });
  });
});
