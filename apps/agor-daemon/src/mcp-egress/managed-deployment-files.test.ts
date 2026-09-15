import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readManagedDeploymentFile } from './managed-deployment-files.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

let directory: string;
let path: string;
beforeEach(() => {
  directory = fs.mkdtempSync(join(fs.realpathSync(process.cwd()), '.managed-file-test-'));
  fs.chmodSync(directory, 0o700);
  path = join(directory, 'evidence.json');
  fs.writeFileSync(path, '{"synthetic":true}', { mode: 0o600 });
  // This test runner's namespace maps host root to nobody. Model root-owned
  // ancestor metadata only; target files, flags and reads are real syscalls.
  const original = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
    const value = original(...args);
    if (value.uid === 65534 && !String(args[0]).startsWith(directory))
      return Object.assign(value, { uid: 0 });
    return value;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});
describe('trusted deployment file reader', () => {
  it('reads bounded regular evidence and opens without following links', () => {
    const open = vi.spyOn(fs, 'openSync');
    expect(readManagedDeploymentFile(path, 128).toString()).toBe('{"synthetic":true}');
    expect(open).toHaveBeenCalledWith(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
  });
  it('can finish a stable old snapshot when the monitor atomically publishes its replacement', () => {
    const read = fs.readSync;
    let replaced = false;
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = read(...args);
      if (!replaced) {
        replaced = true;
        const next = join(directory, 'next.json');
        fs.writeFileSync(next, '{"new":true}', { mode: 0o600 });
        fs.renameSync(next, path);
      }
      return count;
    });
    expect(readManagedDeploymentFile(path, 128).toString()).toBe('{"synthetic":true}');
    expect(readManagedDeploymentFile(path, 128).toString()).toBe('{"new":true}');
  });
  it('rejects relative, traversal, symlink leaf and symlink ancestors', () => {
    const link = join(directory, 'link');
    fs.symlinkSync(path, link);
    const dirLink = join(directory, 'dir-link');
    fs.symlinkSync(directory, dirLink);
    for (const candidate of ['relative', `${directory}/../other`, link, `${dirLink}/evidence.json`])
      expect(() => readManagedDeploymentFile(candidate, 128)).toThrow('unavailable or unsafe');
  });
  it('rejects writable parent, group/world writes, permissive private key, hard links and directories', () => {
    fs.chmodSync(directory, 0o777);
    expect(() => readManagedDeploymentFile(path, 128)).toThrow();
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(path, 0o666);
    expect(() => readManagedDeploymentFile(path, 128)).toThrow();
    fs.chmodSync(path, 0o644);
    expect(() => readManagedDeploymentFile(path, 128, true)).toThrow();
    fs.chmodSync(path, 0o600);
    fs.linkSync(path, join(directory, 'hard-link'));
    expect(() => readManagedDeploymentFile(path, 128)).toThrow();
    expect(() => readManagedDeploymentFile(directory, 128)).toThrow();
  });
  it('rejects oversized/empty input before allocating or reading contents', () => {
    const read = vi.spyOn(fs, 'readSync');
    expect(() => readManagedDeploymentFile(path, 2)).toThrow();
    fs.writeFileSync(path, '');
    expect(() => readManagedDeploymentFile(path, 128)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects an untrusted file owner without including path or contents in the error', () => {
    const stat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementation((...args: Parameters<typeof fs.fstatSync>) =>
      Object.assign(stat(...args), { uid: 65432 })
    );
    expect(() => readManagedDeploymentFile(path, 128)).toThrow(
      'Managed MCP OAuth deployment evidence is unavailable or unsafe.'
    );
  });
});
