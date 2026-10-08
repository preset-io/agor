import type { User } from '@agor-live/client';
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHome, resetHome, seed, user } from './testUtils';

vi.mock('../../hooks/useIdleReady', () => ({ useIdleReady: () => false }));

beforeEach(() => {
  resetHome();
  seed({});
});

const openNewMenu = () => fireEvent.click(screen.getByRole('button', { name: /New$/ }));
const menuItemNames = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

describe('HomePage New menu', () => {
  it('lists teammate, branch, and board for members and opens the picked tab', () => {
    const onOpenCreateDialog = vi.fn();
    renderHome({ onOpenCreateDialog });

    openNewMenu();
    expect(menuItemNames()).toEqual(['Teammate', 'Branch', 'Board']);

    fireEvent.click(screen.getByRole('menuitem', { name: /Board$/ }));
    expect(onOpenCreateDialog).toHaveBeenCalledExactlyOnceWith('board');
  });

  it('adds Repository for admins', () => {
    const onOpenCreateDialog = vi.fn();
    renderHome({ onOpenCreateDialog, currentUser: { ...user, role: 'admin' } as User });

    openNewMenu();
    expect(menuItemNames()).toEqual(['Teammate', 'Branch', 'Board', 'Repository']);

    fireEvent.click(screen.getByRole('menuitem', { name: /Repository$/ }));
    expect(onOpenCreateDialog).toHaveBeenCalledExactlyOnceWith('repository');
  });

  it('hides the button when the shell has no create dialog', () => {
    renderHome();
    expect(screen.queryByRole('button', { name: /New$/ })).not.toBeInTheDocument();
  });
});
