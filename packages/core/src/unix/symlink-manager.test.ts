/**
 * Tests for Symlink Management Utilities
 *
 * These tests cover:
 * - Symlink path generation
 * - Symlink info building
 * - Command string builders
 */

import { describe, expect, it } from 'vitest';
import { buildSymlinkInfo, getWorktreeSymlinkPath, SymlinkCommands } from './symlink-manager.js';

describe('symlink-manager', () => {
  // =========================================================================
  // Path Generation
  // =========================================================================

  describe('getWorktreeSymlinkPath', () => {
    it('generates symlink path in user home', () => {
      const path = getWorktreeSymlinkPath('alice', 'my-feature');
      expect(path).toBe('/home/alice/agor/worktrees/my-feature');
    });

    it('handles various worktree names', () => {
      expect(getWorktreeSymlinkPath('alice', 'feature-123')).toBe(
        '/home/alice/agor/worktrees/feature-123'
      );
      expect(getWorktreeSymlinkPath('alice', 'bugfix_urgent')).toBe(
        '/home/alice/agor/worktrees/bugfix_urgent'
      );
    });

    it('uses custom home base', () => {
      const path = getWorktreeSymlinkPath('alice', 'my-feature', '/users');
      expect(path).toBe('/users/alice/agor/worktrees/my-feature');
    });

    it('handles agor-generated usernames', () => {
      const path = getWorktreeSymlinkPath('agor_01234567', 'my-feature');
      expect(path).toBe('/home/agor_01234567/agor/worktrees/my-feature');
    });
  });

  // =========================================================================
  // Symlink Info Building
  // =========================================================================

  describe('buildSymlinkInfo', () => {
    it('builds symlink info object', () => {
      const info = buildSymlinkInfo(
        'alice',
        'my-feature',
        '/home/agor/.agor/worktrees/org/repo/my-feature'
      );

      expect(info).toEqual({
        linkPath: '/home/alice/agor/worktrees/my-feature',
        targetPath: '/home/agor/.agor/worktrees/org/repo/my-feature',
        worktreeName: 'my-feature',
      });
    });

    it('uses custom home base', () => {
      const info = buildSymlinkInfo('alice', 'my-feature', '/data/worktrees/my-feature', '/users');

      expect(info.linkPath).toBe('/users/alice/agor/worktrees/my-feature');
      expect(info.targetPath).toBe('/data/worktrees/my-feature');
    });
  });

  // =========================================================================
  // Command Builders
  // =========================================================================

  describe('SymlinkCommands', () => {
    describe('symlinkExists', () => {
      it('generates test -L command', () => {
        expect(SymlinkCommands.symlinkExists('/home/alice/link')).toBe(
          'test -L "/home/alice/link"'
        );
      });
    });

    describe('pathExists', () => {
      it('generates test -e command', () => {
        expect(SymlinkCommands.pathExists('/home/alice/file')).toBe('test -e "/home/alice/file"');
      });
    });

    describe('createSymlink', () => {
      it('generates ln -s command', () => {
        const cmd = SymlinkCommands.createSymlink('/data/worktree', '/home/alice/link');
        expect(cmd).toBe('ln -s "/data/worktree" "/home/alice/link"');
      });
    });

    describe('createOrReplaceSymlink', () => {
      it('generates ln -sfn command', () => {
        const cmd = SymlinkCommands.createOrReplaceSymlink('/data/worktree', '/home/alice/link');
        expect(cmd).toBe('ln -sfn "/data/worktree" "/home/alice/link"');
      });
    });

    describe('removeSymlink', () => {
      it('generates rm -f command', () => {
        expect(SymlinkCommands.removeSymlink('/home/alice/link')).toBe('rm -f "/home/alice/link"');
      });
    });

    describe('readSymlink', () => {
      it('generates readlink command', () => {
        expect(SymlinkCommands.readSymlink('/home/alice/link')).toBe('readlink "/home/alice/link"');
      });
    });

    describe('listSymlinks', () => {
      it('generates find command for symlinks', () => {
        expect(SymlinkCommands.listSymlinks('/home/alice/agor/worktrees')).toBe(
          `find "/home/alice/agor/worktrees" -maxdepth 1 -type l -printf '%f\\n'`
        );
      });
    });

    describe('createSymlinkWithOwnership', () => {
      it('returns array of mkdir + chown + ln + chown -h commands', () => {
        const cmds = SymlinkCommands.createSymlinkWithOwnership(
          '/data/worktree',
          '/home/alice/agor/worktrees/my-feature',
          'alice'
        );

        expect(cmds).toEqual([
          'mkdir -p "/home/alice/agor/worktrees"',
          'chown "alice:alice" "/home/alice/agor/worktrees"',
          'ln -sfn "/data/worktree" "/home/alice/agor/worktrees/my-feature"',
          'chown -h "alice:alice" "/home/alice/agor/worktrees/my-feature"',
        ]);
      });

      it('handles nested paths correctly', () => {
        const cmds = SymlinkCommands.createSymlinkWithOwnership(
          '/data/wt',
          '/home/bob/agor/worktrees/feature',
          'bob'
        );

        // Should create parent dir /home/bob/agor/worktrees
        expect(cmds[0]).toBe('mkdir -p "/home/bob/agor/worktrees"');
        expect(cmds).toContainEqual(expect.stringContaining('chown "bob:bob"'));
      });
    });

    describe('removeAllSymlinks', () => {
      it('generates find -delete command', () => {
        expect(SymlinkCommands.removeAllSymlinks('/home/alice/agor/worktrees')).toBe(
          'find "/home/alice/agor/worktrees" -maxdepth 1 -type l -delete'
        );
      });
    });

    describe('removeBrokenSymlinks', () => {
      it('generates find command for broken symlinks', () => {
        const cmd = SymlinkCommands.removeBrokenSymlinks('/home/alice/agor/worktrees');
        expect(cmd).toBe(
          `find "/home/alice/agor/worktrees" -maxdepth 1 -type l ! -exec test -e {} \\; -delete`
        );
      });
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles paths with spaces when quoted', () => {
      const cmd = SymlinkCommands.createSymlink(
        '/data/my worktree',
        '/home/alice/agor/worktrees/my feature'
      );
      expect(cmd).toBe('ln -s "/data/my worktree" "/home/alice/agor/worktrees/my feature"');
    });

    it('handles empty worktree name gracefully', () => {
      // This shouldn't happen in practice, but the function handles it
      const path = getWorktreeSymlinkPath('alice', '');
      expect(path).toBe('/home/alice/agor/worktrees/');
    });
  });
});
