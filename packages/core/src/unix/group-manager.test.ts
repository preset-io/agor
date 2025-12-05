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
    it('has correct mode for none (no access)', () => {
      expect(WorktreePermissionModes.none).toBe('2750');
    });

    it('has correct mode for read (read-only)', () => {
      expect(WorktreePermissionModes.read).toBe('2755');
    });

    it('has correct mode for write (read-write)', () => {
      expect(WorktreePermissionModes.write).toBe('2777');
    });

    it('all modes have setgid bit (2xxx)', () => {
      expect(WorktreePermissionModes.none.startsWith('2')).toBe(true);
      expect(WorktreePermissionModes.read.startsWith('2')).toBe(true);
      expect(WorktreePermissionModes.write.startsWith('2')).toBe(true);
    });
  });

  describe('getWorktreePermissionMode', () => {
    it('returns correct mode for each access level', () => {
      expect(getWorktreePermissionMode('none')).toBe('2750');
      expect(getWorktreePermissionMode('read')).toBe('2755');
      expect(getWorktreePermissionMode('write')).toBe('2777');
    });

    it('defaults to read when no argument', () => {
      expect(getWorktreePermissionMode()).toBe('2755');
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
      it('generates chgrp + chmod command wrapped in sh -c', () => {
        const cmd = UnixGroupCommands.setDirectoryGroup('/data/project', 'developers', '2775');
        expect(cmd).toBe(
          `sh -c 'chgrp -R developers "/data/project" && chmod -R 2775 "/data/project"'`
        );
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
