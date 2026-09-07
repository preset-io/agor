import type { BranchEnvironmentInstance } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EnvironmentAccessLinks } from './EnvironmentAccessLinks';

describe('Environment access links', () => {
  it('renders a result-only Preview URL and prefers reported links over static fallback', () => {
    const environment: BranchEnvironmentInstance = {
      status: 'running',
      access_urls: [{ name: 'Preview', url: 'https://preview.example.test' }],
    };
    const { rerender } = render(<EnvironmentAccessLinks environment={environment} />);
    expect(screen.getByRole('link', { name: 'Preview' })).toHaveAttribute(
      'href',
      'https://preview.example.test'
    );
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
    rerender(
      <EnvironmentAccessLinks environment={environment} appUrl="https://static.example.test" />
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://preview.example.test');
  });
  it('validates stored URLs again at rendering and preserves safe static fallback', () => {
    const environment: BranchEnvironmentInstance = {
      status: 'running',
      access_urls: [
        { name: 'Unsafe', url: 'javascript:alert(1)' },
        { name: 'Credential', url: 'https://user:secret@example.test' },
      ],
    };
    const { rerender } = render(<EnvironmentAccessLinks environment={environment} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    rerender(
      <EnvironmentAccessLinks environment={environment} appUrl="https://static.example.test" />
    );
    expect(screen.getByRole('link', { name: 'App' })).toHaveAttribute(
      'href',
      'https://static.example.test'
    );
    rerender(<EnvironmentAccessLinks appUrl="javascript:alert(1)" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
