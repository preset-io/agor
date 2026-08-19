import type { UserID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../test-helpers';
import { AppVariableRepository } from './app-variables';
import {
  MCP_MEMBER_POLICY_KEY,
  MCP_MEMBER_POLICY_NAMESPACE,
  resolveMcpMemberPolicy,
  setMcpMemberPolicy,
} from './mcp-member-policy';

const USER = '00000000-0000-7000-8000-00000000a11c' as UserID;

describe('resolveMcpMemberPolicy', () => {
  dbTest('an unset policy is the restrictive one', async ({ db }) => {
    await expect(resolveMcpMemberPolicy(db, USER, undefined)).resolves.toBe('use_existing_only');
  });

  dbTest('reads back what an admin set', async ({ db }) => {
    await setMcpMemberPolicy(db, 'allow_private_only', undefined);
    await expect(resolveMcpMemberPolicy(db, USER, undefined)).resolves.toBe('allow_private_only');

    await setMcpMemberPolicy(db, 'allow_crud', undefined);
    await expect(resolveMcpMemberPolicy(db, USER, undefined)).resolves.toBe('allow_crud');
  });

  dbTest('is the same for every user while the setting is tenant-wide', async ({ db }) => {
    await setMcpMemberPolicy(db, 'allow_private_only', undefined);
    const other = '00000000-0000-7000-8000-00000000b0b0' as UserID;
    await expect(resolveMcpMemberPolicy(db, other, undefined)).resolves.toBe('allow_private_only');
    await expect(resolveMcpMemberPolicy(db, undefined, undefined)).resolves.toBe(
      'allow_private_only'
    );
  });

  dbTest('a value nobody recognizes does not widen anything', async ({ db }) => {
    await new AppVariableRepository(db).set({
      namespace: MCP_MEMBER_POLICY_NAMESPACE,
      key: MCP_MEMBER_POLICY_KEY,
      value: 'allow_everything',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(resolveMcpMemberPolicy(db, USER, undefined)).resolves.toBe('use_existing_only');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  dbTest('refuses to store a value it could not read back', async ({ db }) => {
    await expect(setMcpMemberPolicy(db, 'allow_from_list' as never, undefined)).rejects.toThrow(
      /Unknown mcp_member_policy/
    );
  });
});
