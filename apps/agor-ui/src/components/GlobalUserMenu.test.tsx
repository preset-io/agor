import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GlobalUserMenu } from './GlobalUserMenu';

describe('GlobalUserMenu external app entry', () => {
  function openMenu(externalAppLink?: string) {
    render(<GlobalUserMenu externalAppLink={externalAppLink} externalAppLabel="Open Agor Cloud" />);
    fireEvent.click(screen.getByRole('button'));
  }

  it('links to the external app in a new tab when provided', async () => {
    openMenu('https://console.example.test/');

    const link = await screen.findByRole('link', { name: 'Open Agor Cloud' });
    expect(link).toHaveAttribute('href', 'https://console.example.test/');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('has no external app entry without an http(s) link', async () => {
    openMenu('javascript:alert(1)');

    expect(await screen.findByText('Logout')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
