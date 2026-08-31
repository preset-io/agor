import { hasMinimumRole, ROLES, type User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { canAddMcpServer } from '../components/MCPServer/memberPolicy';
import { enrichAuthenticatedUser, hasObservedOnboardingCompletion } from './currentUserAuthority';

const user = (role: User['role'], name: string): User =>
  ({
    user_id: 'user-1',
    email: 'fresh@example.com',
    name,
    role,
    onboarding_completed: true,
    must_change_password: false,
    created_at: new Date(),
  }) as User;

describe('enrichAuthenticatedUser', () => {
  it('keeps an admin-to-member authentication change authoritative without a users event', () => {
    const authenticated = user('member', 'Fresh auth name');
    const staleDirectory = { ...user('admin', 'Directory display name'), email: 'old@example.com' };

    const effective = enrichAuthenticatedUser(authenticated, staleDirectory);
    expect(effective).toMatchObject({
      user_id: 'user-1',
      role: 'member',
      email: 'fresh@example.com',
      name: 'Directory display name',
    });
    expect(
      canAddMcpServer({
        connectionReady: true,
        role: effective?.role,
        isAdmin: hasMinimumRole(effective?.role, ROLES.ADMIN),
        policy: 'allow_crud',
        userId: effective?.user_id,
        canConfigure: false,
      })
    ).toBe(false);
  });

  it('keeps a member-to-admin launch-auth change authoritative without a users event', () => {
    const authenticated = user('admin', 'Fresh auth name');
    const staleDirectory = user('member', 'Directory display name');

    const effective = enrichAuthenticatedUser(authenticated, staleDirectory);
    expect(effective).toMatchObject({
      role: 'admin',
      name: 'Directory display name',
    });
    expect(hasMinimumRole(effective?.role, ROLES.ADMIN)).toBe(true);
  });

  it('does not enrich from a cached row belonging to another identity', () => {
    const authenticated = user('member', 'Fresh auth name');
    const other = { ...user('admin', 'Other'), user_id: 'user-2' } as User;

    expect(enrichAuthenticatedUser(authenticated, other)).toBe(authenticated);
  });
});

describe('hasObservedOnboardingCompletion', () => {
  it('accepts a same-user directory true as a close-only cross-tab signal', () => {
    const authenticated = { ...user('member', 'Fresh auth'), onboarding_completed: false };
    const completedElsewhere = user('member', 'Directory');

    expect(hasObservedOnboardingCompletion(authenticated, completedElsewhere)).toBe(true);
  });

  it('never lets a directory false undo authenticated completion', () => {
    const authenticated = user('member', 'Fresh auth');
    const staleDirectory = { ...user('member', 'Directory'), onboarding_completed: false };

    expect(hasObservedOnboardingCompletion(authenticated, staleDirectory)).toBe(true);
  });

  it('ignores completion from a different directory identity', () => {
    const authenticated = { ...user('member', 'Fresh auth'), onboarding_completed: false };
    const other = { ...user('member', 'Other'), user_id: 'user-2' } as User;

    expect(hasObservedOnboardingCompletion(authenticated, other)).toBe(false);
  });
});
