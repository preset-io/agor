import { branchMaintenanceCapabilities } from '@agor/core/config';
import inquirer from 'inquirer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BranchRemove from './rm';

vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());

function fixture(supported: boolean | undefined, force = false) {
  const branch = {
    branch_id: '019c1234-5678-7123-8123-123456789abc',
    name: 'fixture',
    path: '/fixture',
    maintenance_capabilities:
      supported === undefined
        ? undefined
        : branchMaintenanceCapabilities(
            {
              execution: { unix_user_mode: 'delegated', delegated_branch_deletion: supported },
            },
            'clone'
          ),
  };
  const remove = vi.fn(async () => ({ ...branch, deletion_status: 'deleting' }));
  const client = {
    service: (path: string) =>
      path === 'branches'
        ? { get: vi.fn(async () => branch), remove }
        : { findAll: vi.fn(async () => []) },
  };
  const cleanupClient = vi.fn();
  const command = Object.assign(Object.create(BranchRemove.prototype) as BranchRemove, {
    parse: vi.fn(async () => ({ args: { branchId: branch.branch_id }, flags: { force } })),
    connectToDaemon: vi.fn(async () => client),
    cleanupClient,
    log: vi.fn(),
    error: (message: string) => {
      throw new Error(message);
    },
  });
  vi.mocked(inquirer.prompt).mockClear();
  return { command, remove, cleanupClient };
}

describe('branch rm capability preflight', () => {
  it.each([false, undefined])(
    'refuses unsupported/missing capability %s even with --force, before prompting',
    async (supported) => {
      for (const force of [false, true]) {
        const { command, remove, cleanupClient } = fixture(supported, force);
        await expect(command.run()).rejects.toThrow(
          supported === undefined ? 'upgrade the daemon' : 'execution.delegated_branch_deletion'
        );
        expect(inquirer.prompt).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(cleanupClient).toHaveBeenCalled();
      }
    }
  );
  it('requests permanent deletion only after confirmation and reports acceptance, not completion', async () => {
    const { command, remove } = fixture(true);
    vi.mocked(inquirer.prompt).mockResolvedValue({ confirmed: true });
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await command.run();
    expect(inquirer.prompt).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(expect.any(String), {
      query: { deleteFromFilesystem: true },
    });
    expect(command.log).toHaveBeenCalledWith(
      expect.stringContaining('Deletion requested. The branch remains visible')
    );
  });
  it('does not delete when confirmation is cancelled', async () => {
    const { command, remove } = fixture(true);
    vi.mocked(inquirer.prompt).mockResolvedValue({ confirmed: false });
    await command.run();
    expect(remove).not.toHaveBeenCalled();
  });
});
