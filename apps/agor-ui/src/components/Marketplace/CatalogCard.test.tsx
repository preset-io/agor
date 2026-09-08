import type { MCPCatalogEntry } from '@agor/core/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogCard } from './CatalogCard';

// jsdom/cssstyle cannot compute Ant Tooltip's portal styles when antd's CSS
// variable border shorthands are mounted. Keep the real card/typography/tag
// components and expose only the tooltip input as a stable component contract;
// the real-browser Marketplace smoke exercises Ant's actual overlay.
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Tooltip: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
      <div data-testid="status-tooltip" data-tooltip={String(title)}>
        {children}
      </div>
    ),
  };
});

const ENTRY: MCPCatalogEntry = {
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  description: 'Repository answers',
  transport: 'streamable-http',
  remote_url: 'https://mcp.deepwiki.com/mcp',
  has_remote: true,
  category: 'dev-tools',
  capabilities: ['docs', 'code-search', 'issues', 'pull-requests', 'ci-cd'],
  benefit:
    'Ask detailed questions about any public GitHub repository without leaving your workspace.',
  starter_prompt: 'Explain this repository.',
  permission_disclosure: 'Reads public repositories.',
  auth_type: 'none',
};

afterEach(() => vi.restoreAllMocks());

describe('Marketplace catalog card', () => {
  it('falls back to the server initial when an avatar image cannot load', async () => {
    const { container } = render(
      <CatalogCard
        entry={{ ...ENTRY, icon_url: 'https://images.invalid/deepwiki.png' }}
        onOpen={vi.fn()}
      />
    );
    const image = container.querySelector('.ant-avatar img');
    expect(image).not.toBeNull();

    fireEvent.error(image!);

    await waitFor(() => expect(container.querySelector('.ant-avatar img')).not.toBeInTheDocument());
    expect(container.querySelector('.ant-avatar-string')).toHaveTextContent('D');
  });

  it('keeps the complete benefit in the DOM while applying a two-line visual clamp', () => {
    render(<CatalogCard entry={ENTRY} onOpen={vi.fn()} />);

    const benefit = screen.getByText(ENTRY.benefit);
    expect(benefit).toHaveTextContent(ENTRY.benefit);
    expect(benefit).toHaveClass('ant-typography-ellipsis-multiple-line');
    expect(benefit.style.webkitLineClamp).toBe('2');
  });

  it('shows only three capability chips and summarizes the overflow', () => {
    render(<CatalogCard entry={ENTRY} onOpen={vi.fn()} />);

    expect(screen.getByText('Docs')).toBeInTheDocument();
    expect(screen.getByText('Code search')).toBeInTheDocument();
    expect(screen.getByText('Issues')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.queryByText('Pull requests')).not.toBeInTheDocument();
    expect(screen.queryByText('Ci cd')).not.toBeInTheDocument();
  });

  it('explains the connection status in a tooltip', () => {
    render(<CatalogCard entry={ENTRY} onOpen={vi.fn()} />);

    expect(screen.getByText('Catalog says no account')).toBeInTheDocument();
    expect(screen.getByTestId('status-tooltip')).toHaveAttribute(
      'data-tooltip',
      'Catalog metadata says this server needs no account. Agor checks the live endpoint before connecting.'
    );
  });

  it('opens from click, Enter, and Space without allowing Space to scroll', () => {
    const onOpen = vi.fn();
    render(<CatalogCard entry={ENTRY} onOpen={onOpen} />);
    const card = screen.getByRole('button', { name: 'Open DeepWiki' });

    fireEvent.click(card);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    card.dispatchEvent(enter);
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    card.dispatchEvent(space);

    expect(enter.defaultPrevented).toBe(true);
    expect(space.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenNthCalledWith(1, ENTRY);
    expect(onOpen).toHaveBeenNthCalledWith(2, ENTRY);
    expect(onOpen).toHaveBeenNthCalledWith(3, ENTRY);
  });
});
