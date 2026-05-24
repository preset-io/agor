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
import type { BranchID } from '../types/index.js';
import {
  AGOR_USERS_GROUP,
  BranchPermissionModes,
  generateBranchGroupName,
  getBranchPermissionMode,
  isValidBranchGroupName,
  parseBranchGroupName,
  UnixGroupCommands,
} from './group-manager.js';

describe('group-manager', () => {
  // =========================================================================
  // Group Name Generation
  // =========================================================================

  describe('generateBranchGroupName', () => {
    it('generates group name from UUID with agor_wt_ prefix', () => {
      const branchId = '01234567-89ab-cdef-0123-456789abcdef' as BranchID;
      const groupName = generateBranchGroupName(branchId);
      expect(groupName).toBe('agor_wt_01234567');
    });

    it('uses first 8 chars of UUID as short ID', () => {
      const branchId = 'abcdef01-2345-6789-abcd-ef0123456789' as BranchID;
      const groupName = generateBranchGroupName(branchId);
      expect(groupName).toBe('agor_wt_abcdef01');
    });

    it('handles UUIDv7 format correctly', () => {
      const branchId = '019377a4-5c3b-7def-8abc-123456789abc' as BranchID;
      const groupName = generateBranchGroupName(branchId);
      expect(groupName).toBe('agor_wt_019377a4');
    });
  });

  // =========================================================================
  // Group Name Parsing
  // =========================================================================

  describe('parseBranchGroupName', () => {
    it('extracts short ID from valid branch group name', () => {
      expect(parseBranchGroupName('agor_wt_01234567')).toBe('01234567');
      expect(parseBranchGroupName('agor_wt_abcdef01')).toBe('abcdef01');
    });

    it('returns null for non-branch group names', () => {
      expect(parseBranchGroupName('agor_users')).toBeNull();
      expect(parseBranchGroupName('developers')).toBeNull();
      expect(parseBranchGroupName('wheel')).toBeNull();
    });

    it('returns null for invalid branch group formats', () => {
      expect(parseBranchGroupName('agor_wt_')).toBeNull(); // too short
      expect(parseBranchGroupName('agor_wt_1234567')).toBeNull(); // 7 chars
      expect(parseBranchGroupName('agor_wt_123456789')).toBeNull(); // 9 chars
      expect(parseBranchGroupName('agor_wt_ABCDEF01')).toBeNull(); // uppercase
      expect(parseBranchGroupName('agor_wt_1234567g')).toBeNull(); // invalid hex
    });

    it('returns null for user group names (different prefix)', () => {
      expect(parseBranchGroupName('agor_01234567')).toBeNull(); // user, not branch
    });
  });

  // =========================================================================
  // Group Name Validation
  // =========================================================================

  describe('isValidBranchGroupName', () => {
    it('returns true for valid branch group names', () => {
      expect(isValidBranchGroupName('agor_wt_01234567')).toBe(true);
      expect(isValidBranchGroupName('agor_wt_abcdef01')).toBe(true);
      expect(isValidBranchGroupName('agor_wt_00000000')).toBe(true);
      expect(isValidBranchGroupName('agor_wt_ffffffff')).toBe(true);
    });

    it('returns false for invalid formats', () => {
      expect(isValidBranchGroupName('agor_wt_ABCDEF01')).toBe(false); // uppercase
      expect(isValidBranchGroupName('agor_wt_1234567')).toBe(false); // 7 chars
      expect(isValidBranchGroupName('agor_wt_123456789')).toBe(false); // 9 chars
      expect(isValidBranchGroupName('agor_01234567')).toBe(false); // missing wt_
      expect(isValidBranchGroupName('wt_01234567')).toBe(false); // missing agor_
    });
  });

  // =========================================================================
  // Permission Modes
  // =========================================================================

  describe('BranchPermissionModes', () => {
    // NOTE: Group (owners) ALWAYS gets 7 (rwx) because they access via group membership.
    // The 'others_fs_access' setting controls what OTHERS (non-owners) get:
    // - 'none'  → others get 0 (---)
    // - 'read'  → others get 5 (r-x)
    // - 'write' → others get 7 (rwx)

    it('has correct mode for none (no access for others)', () => {
      // 2770 = setgid + owner:rwx + group:rwx + others:---
      expect(BranchPermissionModes.none).toBe('2770');
    });

    it('has correct mode for read (read-only for others)', () => {
      // 2775 = setgid + owner:rwx + group:rwx + others:r-x
      expect(BranchPermissionModes.read).toBe('2775');
    });

    it('has correct mode for write (read-write for others)', () => {
      // 2777 = setgid + owner:rwx + group:rwx + others:rwx
      expect(BranchPermissionModes.write).toBe('2777');
    });

    it('all modes have setgid bit (2xxx)', () => {
      expect(BranchPermissionModes.none.startsWith('2')).toBe(true);
      expect(BranchPermissionModes.read.startsWith('2')).toBe(true);
      expect(BranchPermissionModes.write.startsWith('2')).toBe(true);
    });

    it('all modes give group full access (x7xx)', () => {
      // Group always gets 7 (rwx) because owners access files via group membership
      expect(BranchPermissionModes.none[1]).toBe('7');
      expect(BranchPermissionModes.read[1]).toBe('7');
      expect(BranchPermissionModes.write[1]).toBe('7');
    });
  });

  describe('getBranchPermissionMode', () => {
    it('returns correct mode for each access level', () => {
      expect(getBranchPermissionMode('none')).toBe('2770');
      expect(getBranchPermissionMode('read')).toBe('2775');
      expect(getBranchPermissionMode('write')).toBe('2777');
    });

    it('defaults to read when no argument', () => {
      expect(getBranchPermissionMode()).toBe('2775');
    });
  });

  // =========================================================================
  // Command Builders
  // =========================================================================

  describe('UnixGroupCommands', () => {
    describe('createGroup', () => {
      it('generates groupadd command', () => {
        expect(UnixGroupCommands.createGroup('agor_wt_01234567')).toBe(
          'sudo -n groupadd agor_wt_01234567'
        );
      });
    });

    describe('deleteGroup', () => {
      it('generates groupdel command', () => {
        expect(UnixGroupCommands.deleteGroup('agor_wt_01234567')).toBe(
          'sudo -n groupdel agor_wt_01234567'
        );
      });
    });

    describe('addUserToGroup', () => {
      it('generates usermod -aG command', () => {
        expect(UnixGroupCommands.addUserToGroup('alice', 'developers')).toBe(
          'sudo -n usermod -aG developers alice'
        );
      });
    });

    describe('removeUserFromGroup', () => {
      it('generates gpasswd -d command', () => {
        expect(UnixGroupCommands.removeUserFromGroup('alice', 'developers')).toBe(
          'sudo -n gpasswd -d alice developers'
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

    describe('setUserAcl', () => {
      it('returns recursive ACL commands for a specific user', () => {
        const cmds = UnixGroupCommands.setUserAcl('/data/branch', 'agorpg');
        expect(cmds).toEqual([
          'sudo -n setfacl -R -m u:agorpg:rwX "/data/branch"',
          'sudo -n setfacl -R -d -m u:agorpg:rwX "/data/branch"',
        ]);
      });
    });

    describe('setUserAclShallow', () => {
      it('returns non-recursive ACL command for a specific user', () => {
        const cmds = UnixGroupCommands.setUserAclShallow('/data/repo', 'agorpg');
        expect(cmds).toEqual(['sudo -n setfacl -m u:agorpg:rwX "/data/repo"']);
      });
    });

    describe('setDirectoryGroup', () => {
      it('returns ACL-based commands for others read (2775)', () => {
        const cmds = UnixGroupCommands.setDirectoryGroup('/data/project', 'developers', '2775');
        expect(cmds).toEqual([
          'sudo -n chgrp -R developers "/data/project"',
          'sudo -n setfacl -R -m u::rwX "/data/project"',
          'sudo -n setfacl -R -m g:developers:rwX "/data/project"',
          'sudo -n setfacl -R -m o::rX "/data/project"',
          'sudo -n setfacl -R -m m::rwX "/data/project"',
          'sudo -n setfacl -R -d -m u::rwX,g:developers:rwX,o::rX,m::rwX "/data/project"',
          'sudo -n find "/data/project" -type d -exec chmod g+s {} +',
        ]);
      });

      it('returns ACL-based commands for no others access (2770)', () => {
        const cmds = UnixGroupCommands.setDirectoryGroup('/data/secret', 'admins', '2770');
        expect(cmds).toEqual([
          'sudo -n chgrp -R admins "/data/secret"',
          'sudo -n setfacl -R -m u::rwX "/data/secret"',
          'sudo -n setfacl -R -m g:admins:rwX "/data/secret"',
          'sudo -n setfacl -R -m o::--- "/data/secret"',
          'sudo -n setfacl -R -m m::rwX "/data/secret"',
          'sudo -n setfacl -R -d -m u::rwX,g:admins:rwX,o::---,m::rwX "/data/secret"',
          'sudo -n find "/data/secret" -type d -exec chmod g+s {} +',
        ]);
      });

      it('returns ACL-based commands for full others access (2777)', () => {
        const cmds = UnixGroupCommands.setDirectoryGroup('/data/public', 'everyone', '2777');
        expect(cmds).toEqual([
          'sudo -n chgrp -R everyone "/data/public"',
          'sudo -n setfacl -R -m u::rwX "/data/public"',
          'sudo -n setfacl -R -m g:everyone:rwX "/data/public"',
          'sudo -n setfacl -R -m o::rwX "/data/public"',
          'sudo -n setfacl -R -m m::rwX "/data/public"',
          'sudo -n setfacl -R -d -m u::rwX,g:everyone:rwX,o::rwX,m::rwX "/data/public"',
          'sudo -n find "/data/public" -type d -exec chmod g+s {} +',
        ]);
      });
    });

    describe('setDirectoryGroupShallow', () => {
      it('returns ACL-based commands without recursion for no others access (2770)', () => {
        const cmds = UnixGroupCommands.setDirectoryGroupShallow('/data/repo', 'developers', '2770');
        expect(cmds).toEqual([
          'sudo -n chgrp developers "/data/repo"',
          'sudo -n setfacl -m u::rwX "/data/repo"',
          'sudo -n setfacl -m g:developers:rwX "/data/repo"',
          'sudo -n setfacl -m o::--- "/data/repo"',
          'sudo -n setfacl -m m::rwX "/data/repo"',
          'sudo -n chmod g+s "/data/repo"',
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
