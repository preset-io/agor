import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CatalogEntryAvatar } from './CatalogEntryAvatar';

describe('CatalogEntryAvatar', () => {
  it('renders a successfully loaded catalog logo with accessible text', () => {
    const { container } = render(
      <CatalogEntryAvatar iconUrl="https://example.com/linear.png" title="Linear" />
    );
    const image = screen.getByRole('img', { name: 'Linear logo' });

    fireEvent.load(image);

    expect(image).toHaveAttribute('src', 'https://example.com/linear.png');
    expect(container.querySelector('.ant-avatar img')).toBe(image);
  });

  it('falls back to the server initial when the logo cannot load', async () => {
    const { container } = render(
      <CatalogEntryAvatar iconUrl="https://images.invalid/linear.png" title="Linear" />
    );

    fireEvent.error(screen.getByRole('img', { name: 'Linear logo' }));

    await waitFor(() => expect(screen.queryByRole('img')).not.toBeInTheDocument());
    expect(container.querySelector('.ant-avatar-string')).toHaveTextContent('L');
  });

  it('renders the accessible initial fallback when no logo is provided', () => {
    const { container } = render(<CatalogEntryAvatar title="Linear" />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('.ant-avatar-string')).toHaveTextContent('L');
  });
});
