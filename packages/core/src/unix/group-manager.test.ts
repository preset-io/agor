/**
 * Tests for Unix Group Management Utilities
 *
 * These tests cover:
 * - Group name generation and parsing
 * - Group name validation
 * - Permission mode lookup
 * - Command string builders
 */

import { describe, expect, it } from 'vitest';
import type { WorktreeID } from '../types/index.js';
import {
  AGOR_USERS_GROUP,
  generateWorktreeGroupName,
  getWorktreePermissionMode,
  isValidWorktreeGroupName,
  parseWorktreeGroupName,
  UnixGroupCommands,
  WorktreePermissionModes,
} from './group-manager.js';

describe('group-manager', () => {
  // =========================================================================
  // Group Name Generation
  // =========================================================================

  describe('generateWorktreeGroupName', () => {
    it('generates group name from UUID with agor_wt_ prefix', () => {
      const worktreeId = '01234567-89ab-cdef-0123-456789abcdef' as WorktreeID;
      const groupName = generateWorktreeGroupName(worktreeId);
      expect(groupName).toBe('agor_wt_01234567');
    });

    it('uses first 8 chars of UUID as short ID', () => {
      const worktreeId = 'abcdef01-2345-6789-abcd-ef0123456789' as WorktreeID;
      const groupName = generateWorktreeGroupName(worktreeId);
      expect(groupName).toBe('agor_wt_abcdef01');
    });

    it('handles UUIDv7 format correctly', () => {
      const worktreeId = '019377a4-5c3b-7def-8abc-123456789abc' as WorktreeID;
      const groupName = generateWorktreeGroupName(worktreeId);
      expect(groupName).toBe('agor_wt_019377a4');
    });
  });

  // =========================================================================
  // Group Name Parsing
  // =========================================================================

  describe('parseWorktreeGroupName', () => {
    it('extracts short ID from valid worktree group name', () => {
      expect(parseWorktreeGroupName('agor_wt_01234567')).toBe('01234567');
      expect(parseWorktreeGroupName('agor_wt_abcdef01')).toBe('abcdef01');
    });

    it('returns null for non-worktree group names', () => {
      expect(parseWorktreeGroupName('agor_users')).toBeNull();
      expect(parseWorktreeGroupName('developers')).toBeNull();
      expect(parseWorktreeGroupName('wheel')).toBeNull();
    });

    it('returns null for invalid worktree group formats', () => {
      expect(parseWorktreeGroupName('agor_wt_')).toBeNull(); // too short
      expect(parseWorktreeGroupName('agor_wt_1234567')).toBeNull(); // 7 chars
      expect(parseWorktreeGroupName('agor_wt_123456789')).toBeNull(); // 9 chars
      expect(parseWorktreeGroupName('agor_wt_ABCDEF01')).toBeNull(); // uppercase
      expect(parseWorktreeGroupName('agor_wt_1234567g')).toBeNull(); // invalid hex
    });

    it('returns null for user group names (different prefix)', () => {
      expect(parseWorktreeGroupName('agor_01234567')).toBeNull(); // user, not worktree
    });
  });

  // =========================================================================
  // Group Name Validation
  // =========================================================================

  describe('isValidWorktreeGroupName', () => {
    it('returns true for valid worktree group names', () => {
      expect(isValidWorktreeGroupName('agor_wt_01234567')).toBe(true);
      expect(isValidWorktreeGroupName('agor_wt_abcdef01')).toBe(true);
      expect(isValidWorktreeGroupName('agor_wt_00000000')).toBe(true);
      expect(isValidWorktreeGroupName('agor_wt_ffffffff')).toBe(true);
    });

    it('returns false for invalid formats', () => {
      expect(isValidWorktreeGroupName('agor_wt_ABCDEF01')).toBe(false); // uppercase
      expect(isValidWorktreeGroupName('agor_wt_1234567')).toBe(false); // 7 chars
      expect(isValidWorktreeGroupName('agor_wt_123456789')).toBe(false); // 9 chars
      expect(isValidWorktreeGroupName('agor_01234567')).toBe(false); // missing wt_
      expect(isValidWorktreeGroupName('wt_01234567')).toBe(false); // missing agor_
    });
  });

  // =========================================================================
  // Permission Modes
  // =========================================================================

  describe('WorktreePermissionModes', () => {
    // NOTE: Group (owners) ALWAYS gets 7 (rwx) because they access via group membership.
    // The 'others_fs_access' setting controls what OTHERS (non-owners) get:
    // - 'none'  → others get 0 (---)
    // - 'read'  → others get 5 (r-x)
    // - 'write' → others get 7 (rwx)

    it('has correct mode for none (no access for others)', () => {
      // 2770 = setgid + owner:rwx + group:rwx + others:---
      expect(WorktreePermissionModes.none).toBe('2770');
    });

    it('has correct mode for read (read-only for others)', () => {
      // 2775 = setgid + owner:rwx + group:rwx + others:r-x
      expect(WorktreePermissionModes.read).toBe('2775');
    });

    it('has correct mode for write (read-write for others)', () => {
      // 2777 = setgid + owner:rwx + group:rwx + others:rwx
      expect(WorktreePermissionModes.write).toBe('2777');
    });

    it('all modes have setgid bit (2xxx)', () => {
      expect(WorktreePermissionModes.none.startsWith('2')).toBe(true);
      expect(WorktreePermissionModes.read.startsWith('2')).toBe(true);
      expect(WorktreePermissionModes.write.startsWith('2')).toBe(true);
    });

    it('all modes give group full access (x7xx)', () => {
      // Group always gets 7 (rwx) because owners access files via group membership
      expect(WorktreePermissionModes.none[1]).toBe('7');
      expect(WorktreePermissionModes.read[1]).toBe('7');
      expect(WorktreePermissionModes.write[1]).toBe('7');
    });
  });

  describe('getWorktreePermissionMode', () => {
    it('returns correct mode for each access level', () => {
      expect(getWorktreePermissionMode('none')).toBe('2770');
      expect(getWorktreePermissionMode('read')).toBe('2775');
      expect(getWorktreePermissionMode('write')).toBe('2777');
    });

    it('defaults to read when no argument', () => {
      expect(getWorktreePermissionMode()).toBe('2775');
    });
  });

  // =========================================================================
  // Command Builders
  // =========================================================================

  describe('UnixGroupCommands', () => {
    describe('createGroup', () => {
      it('generates groupadd command', () => {
        expect(UnixGroupCommands.createGroup('agor_wt_01234567')).toBe('groupadd agor_wt_01234567');
      });
    });

    describe('deleteGroup', () => {
      it('generates groupdel command', () => {
        expect(UnixGroupCommands.deleteGroup('agor_wt_01234567')).toBe('groupdel agor_wt_01234567');
      });
    });

    describe('addUserToGroup', () => {
      it('generates usermod -aG command', () => {
        expect(UnixGroupCommands.addUserToGroup('alice', 'developers')).toBe(
          'usermod -aG developers alice'
        );
      });
    });

    describe('removeUserFromGroup', () => {
      it('generates gpasswd -d command', () => {
        expect(UnixGroupCommands.removeUserFromGroup('alice', 'developers')).toBe(
          'gpasswd -d alice developers'
        );
      });
    });

    describe('groupExists', () => {
      it('generates getent group command', () => {
        expect(UnixGroupCommands.groupExists('agor_wt_01234567')).toBe(
          'getent group agor_wt_01234567 > /dev/null'
        );
      });
    });

    describe('isUserInGroup', () => {
      it('generates id + grep command', () => {
        expect(UnixGroupCommands.isUserInGroup('alice', 'developers')).toBe(
          'id -nG alice | grep -qw developers'
        );
      });
    });

    describe('listGroupMembers', () => {
      it('generates getent + cut command', () => {
        expect(UnixGroupCommands.listGroupMembers('developers')).toBe(
          'getent group developers | cut -d: -f4'
        );
      });
    });

    describe('setDirectoryGroup', () => {
      it('returns ACL-based commands for others read (2775)', () => {
        const cmds = UnixGroupCommands.setDirectoryGroup('/data/project', 'developers', '2775');
        expect(cmds).toEqual([
          'chgrp -R developers "/data/project"',
          'find "/data/project" -type d -exec chmod g+s {} +',
          'setfacl -R -m u::rwX "/data/project"',
          'setfacl -R -m g:developers:rwX "/data/project"',
          'setfacl -R -m o::rX "/data/project"',
          'setfacl -R -d -m u::rwX,g:developers:rwX,o::rX "/data/project"',
        ]);
      });

      it('returns ACL-based commands for no others access (2770)', () => {
        const cmds = UnixGroupCommands.setDirectoryGroup('/data/secret', 'admins', '2770');
        expect(cmds).toEqual([
          'chgrp -R admins "/data/secret"',
          'find "/data/secret" -type d -exec chmod g+s {} +',
          'setfacl -R -m u::rwX "/data/secret"',
          'setfacl -R -m g:admins:rwX "/data/secret"',
          'setfacl -R -m o::--- "/data/secret"',
          'setfacl -R -d -m u::rwX,g:admins:rwX,o::--- "/data/secret"',
        ]);
      });

      it('returns ACL-based commands for full others access (2777)', () => {
        const cmds = UnixGroupCommands.setDirectoryGroup('/data/public', 'everyone', '2777');
        expect(cmds).toEqual([
          'chgrp -R everyone "/data/public"',
          'find "/data/public" -type d -exec chmod g+s {} +',
          'setfacl -R -m u::rwX "/data/public"',
          'setfacl -R -m g:everyone:rwX "/data/public"',
          'setfacl -R -m o::rwX "/data/public"',
          'setfacl -R -d -m u::rwX,g:everyone:rwX,o::rwX "/data/public"',
        ]);
      });
    });
  });

  // =========================================================================
  // Constants
  // =========================================================================

  describe('constants', () => {
    it('AGOR_USERS_GROUP is agor_users', () => {
      expect(AGOR_USERS_GROUP).toBe('agor_users');
    });
  });
});
