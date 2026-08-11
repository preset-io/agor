import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { UIModeProvider } from '../contexts/UIModeContext';
import { UserIdentityAvatar, type UserIdentityAvatarProps } from './UserIdentityAvatar';

const user = {
  name: 'Abhi',
  email: 'abhi@example.com',
  emoji: '🦖',
} as NonNullable<UserIdentityAvatarProps['user']>;

const renderSlim = (ui: React.ReactElement) => {
  localStorage.setItem('agor:uiMode', 'slim');
  return render(<UIModeProvider>{ui}</UIModeProvider>);
};

describe('UserIdentityAvatar', () => {
  beforeEach(() => {
    localStorage.removeItem('agor:uiMode');
  });

  it('renders the user emoji in classic mode (default, no provider)', () => {
    render(<UserIdentityAvatar user={user} />);
    expect(screen.getByText('🦖')).toBeInTheDocument();
  });

  it('falls back to the neutral emoji in classic mode without a user emoji', () => {
    render(<UserIdentityAvatar user={{ ...user, emoji: undefined }} />);
    expect(screen.getByText('👤')).toBeInTheDocument();
  });

  it('renders the name initial instead of the emoji in slim mode', () => {
    renderSlim(<UserIdentityAvatar user={user} />);
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.queryByText('🦖')).not.toBeInTheDocument();
  });

  it('uses the email initial in slim mode when the name is missing', () => {
    renderSlim(
      <UserIdentityAvatar user={{ ...user, name: undefined, email: 'zed@example.com' }} />
    );
    expect(screen.getByText('Z')).toBeInTheDocument();
  });

  it('shows ? in slim mode when no identity is available', () => {
    renderSlim(<UserIdentityAvatar user={null} />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});
