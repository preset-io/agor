import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateDirectory } from './validation';

vi.mock('node:fs/promises');

describe('validateDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should pass for valid directory', async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    } as any);

    await expect(validateDirectory('/valid/dir')).resolves.toBeUndefined();
    expect(fs.stat).toHaveBeenCalledWith('/valid/dir');
  });

  it('should throw when path is a file', async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    } as any);

    await expect(validateDirectory('/path/to/file')).rejects.toThrow(
      'Directory exists but is not a directory: /path/to/file'
    );
  });

  it('should throw when path does not exist', async () => {
    const error: NodeJS.ErrnoException = new Error('ENOENT');
    error.code = 'ENOENT';
    vi.mocked(fs.stat).mockRejectedValue(error);

    await expect(validateDirectory('/nonexistent/path')).rejects.toThrow(
      'Directory does not exist: /nonexistent/path'
    );
  });

  it('should throw for other filesystem errors', async () => {
    const error: NodeJS.ErrnoException = new Error('EACCES: permission denied');
    error.code = 'EACCES';
    vi.mocked(fs.stat).mockRejectedValue(error);

    await expect(validateDirectory('/no/permission')).rejects.toThrow(
      'Directory is not accessible: /no/permission (Error: EACCES: permission denied)'
    );
  });

  it('should use custom context in error messages', async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    } as any);

    await expect(validateDirectory('/path/to/file', 'CWD')).rejects.toThrow(
      'CWD exists but is not a directory: /path/to/file'
    );
  });

  it('should use custom context for ENOENT errors', async () => {
    const error: NodeJS.ErrnoException = new Error('ENOENT');
    error.code = 'ENOENT';
    vi.mocked(fs.stat).mockRejectedValue(error);

    await expect(validateDirectory('/nonexistent', 'branch path')).rejects.toThrow(
      'branch path does not exist: /nonexistent'
    );
  });

  it('should use custom context for access errors', async () => {
    const error: NodeJS.ErrnoException = new Error('EPERM: operation not permitted');
    error.code = 'EPERM';
    vi.mocked(fs.stat).mockRejectedValue(error);

    await expect(validateDirectory('/restricted', 'project directory')).rejects.toThrow(
      'project directory is not accessible: /restricted (Error: EPERM: operation not permitted)'
    );
  });

  it('should handle non-NodeJS errors', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('Unknown error'));

    await expect(validateDirectory('/path')).rejects.toThrow(
      'Directory is not accessible: /path (Error: Unknown error)'
    );
  });

  it('should handle errors without code property', async () => {
    const error = { message: 'Weird error' };
    vi.mocked(fs.stat).mockRejectedValue(error);

    await expect(validateDirectory('/path')).rejects.toThrow(
      'Directory is not accessible: /path ([object Object])'
    );
  });

  it('should handle string errors', async () => {
    vi.mocked(fs.stat).mockRejectedValue('String error');

    await expect(validateDirectory('/path')).rejects.toThrow(
      'Directory is not accessible: /path (String error)'
    );
  });

  it('should use default context when not provided', async () => {
    const error: NodeJS.ErrnoException = new Error('ENOENT');
    error.code = 'ENOENT';
    vi.mocked(fs.stat).mockRejectedValue(error);

    await expect(validateDirectory('/path')).rejects.toThrow('Directory does not exist: /path');
  });

  it('should handle symlinks to directories', async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => true,
      isFIFO: () => false,
      isSocket: () => false,
    } as any);

    await expect(validateDirectory('/symlink/to/dir')).resolves.toBeUndefined();
  });

  it('should handle absolute paths', async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    } as any);

    await expect(validateDirectory('/absolute/path/to/dir')).resolves.toBeUndefined();
    expect(fs.stat).toHaveBeenCalledWith('/absolute/path/to/dir');
  });

  it('should handle relative paths', async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    } as any);

    await expect(validateDirectory('./relative/path')).resolves.toBeUndefined();
    expect(fs.stat).toHaveBeenCalledWith('./relative/path');
  });

  it('should handle paths with spaces', async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    } as any);

    await expect(validateDirectory('/path with spaces/dir')).resolves.toBeUndefined();
    expect(fs.stat).toHaveBeenCalledWith('/path with spaces/dir');
  });

  it('should handle paths with special characters', async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    } as any);

    await expect(validateDirectory('/path/with-dashes_and.dots')).resolves.toBeUndefined();
    expect(fs.stat).toHaveBeenCalledWith('/path/with-dashes_and.dots');
  });
});
