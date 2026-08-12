import type { User } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getUserInitials, UserIdentityAvatar } from './UserIdentityAvatar';

const makeUser = (overrides: Partial<User> = {}): User =>
  ({ user_id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', ...overrides }) as User;

describe('getUserInitials', () => {
  it('uses first and last name initials for multi-word names', () => {
    expect(getUserInitials({ name: 'Ada Lovelace', email: 'x@y.z' } as User)).toBe('AL');
  });

  it('falls back to the first two letters of a single name', () => {
    expect(getUserInitials({ name: 'Rusty', email: 'x@y.z' } as User)).toBe('RU');
  });

  it('derives initials from the email local part when there is no name', () => {
    expect(getUserInitials({ email: 'scout@agor.live' } as User)).toBe('SC');
  });

  it('returns a placeholder when there is no identity', () => {
    expect(getUserInitials(null)).toBe('?');
  });
});

describe('UserIdentityAvatar fallback', () => {
  it('renders initials when there is no slack image or chosen emoji', () => {
    render(<UserIdentityAvatar user={makeUser()} />);
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('keeps a deliberately chosen emoji as identity', () => {
    render(<UserIdentityAvatar user={makeUser({ emoji: '🦊' })} />);
    expect(screen.getByText('🦊')).toBeInTheDocument();
  });

  it('renders the slack image when available', () => {
    render(
      <UserIdentityAvatar
        user={makeUser({ avatar_url: 'https://img/avatar.png', avatar_source: 'slack' })}
      />
    );
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://img/avatar.png');
  });

  it('renders users on a circle so they are never mistaken for boards', () => {
    const { container } = render(<UserIdentityAvatar user={makeUser()} />);
    expect(container.querySelector('.ant-avatar-circle')).toBeInTheDocument();
  });
});
