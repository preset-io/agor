import type { User } from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { MobileMoreSheet } from './MobileMoreSheet';

const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  await page.viewport(originalViewport.width, originalViewport.height);
});

// Short phones and landscape, where an expanded Create new is taller than the screen.
describe('MobileMoreSheet stays on screen and scrolls', () => {
  for (const [width, height] of [
    [360, 640],
    [375, 553],
    [844, 390],
  ]) {
    it(`keeps the header visible and reaches Sign out at ${width}x${height}`, async () => {
      await page.viewport(width, height);
      render(
        <ThemeProvider>
          <MemoryRouter initialEntries={['/m']}>
            <MobileMoreSheet
              open
              onClose={vi.fn()}
              user={{ user_id: 'u1', name: 'Kasia Designer' } as User}
              commentsBadge={3}
              onOpenComments={vi.fn()}
              onCreate={vi.fn()}
              isAdmin
              onOpenWorkspaceSettings={vi.fn()}
              onOpenUserSettings={vi.fn()}
              onLogout={vi.fn()}
            />
          </MemoryRouter>
        </ThemeProvider>
      );
      await userEvent.click(screen.getByRole('button', { name: 'Create new' }));
      await screen.findByRole('button', { name: 'Repository' });

      const dialog = screen.getByRole('dialog');
      const body = dialog.querySelector<HTMLElement>('.ant-drawer-body')!;
      await waitFor(() => {
        // The header (title and close) is on screen, and the sheet ends at the bottom edge.
        expect(screen.getByText('More').getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
        expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      });
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);

      body.scrollTop = body.scrollHeight;
      const signOut = screen.getByRole('button', { name: 'Sign out' }).getBoundingClientRect();
      expect(signOut.bottom).toBeLessThanOrEqual(body.getBoundingClientRect().bottom + 1);
    });
  }
});
