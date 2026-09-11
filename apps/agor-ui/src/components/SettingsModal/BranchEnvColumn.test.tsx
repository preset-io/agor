import type { Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GlobalToken } from 'antd';
import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderEnvCell } from './BranchEnvColumn';

vi.mock('antd', () => ({
  Badge: () => <span />,
  Button: ({
    icon,
    size: _size,
    type: _type,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: ReactNode;
    size?: string;
    type?: string;
  }) => <button {...props}>{icon}</button>,
  Space: ({ children }: PropsWithChildren<{ size?: number }>) => <div>{children}</div>,
  Tooltip: ({ children }: PropsWithChildren<{ title?: ReactNode }>) => <>{children}</>,
}));

const branch = {
  branch_id: 'branch-id',
  repo_id: 'repo-id',
  name: 'branch',
  environment_instance: {
    status: 'running',
    lifecycle_result: {
      version: 1,
      health_url: 'https://runtime.example.test/health',
    },
  },
} as Branch;

const repo = {
  repo_id: 'repo-id',
  name: 'repo',
  environment: {
    version: 2,
    default: 'default',
    variants: { default: { start: 'true', stop: 'true' } },
  },
} as Repo;

describe('renderEnvCell', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens a provider-discovered health URL from Settings', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(renderEnvCell(branch, repo, {} as GlobalToken, {}));

    fireEvent.click(screen.getByRole('button', { name: 'Open environment health' }));

    expect(open).toHaveBeenCalledWith(
      'https://runtime.example.test/health',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
