import type { Branch, Repo } from '@agor-live/client';
import { render, screen, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __setAuthConfigForTests } from '../../../hooks/useAuthConfig';
import { EnvironmentTab } from './EnvironmentTab';

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: () => ({ isAdmin: true }),
}));

const branch = {
  branch_id: 'branch-1',
  name: 'feature/environment-notice',
  environment_variant: 'local',
  start_command: 'pnpm dev',
  stop_command: 'pnpm stop',
  environment_instance: { status: 'stopped' },
} as Branch;

const repo = {
  repo_id: 'repo-1',
  slug: 'preset-io/agor',
  environment: {
    version: 2,
    default: 'local',
    variants: { local: { start: 'pnpm dev', stop: 'pnpm stop' } },
  },
} as Repo;

function renderTab() {
  return render(
    <AntApp>
      <EnvironmentTab branch={branch} repo={repo} client={null} />
    </AntApp>
  );
}

describe('EnvironmentTab deployment notice', () => {
  beforeEach(() => {
    __setAuthConfigForTests({ requireAuth: true }, { managedEnvsExecutionMode: 'hybrid' });
  });

  it('preserves current behavior when the deployment notice is absent', () => {
    renderTab();

    expect(screen.queryByText('Remote environment availability')).not.toBeInTheDocument();
    expect(
      screen.getAllByText(
        'This instance supports shell commands and URL webhooks for start, stop, nuke, and logs.'
      )
    ).not.toHaveLength(0);
  });

  it('renders plain text and a safe new-tab link above the capability summary', () => {
    __setAuthConfigForTests(
      { requireAuth: true },
      { managedEnvsExecutionMode: 'webhook-only' },
      {
        environmentNotice: {
          severity: 'warning',
          title: 'Remote environment availability',
          message: '<img src=x onerror=alert(1)> **Bring your own runtime.**',
          link: {
            label: 'Read the environment guide',
            url: 'https://agor.live/guide/environment-configuration',
          },
        },
      }
    );

    const { container } = renderTab();

    const heading = screen.getByText('Remote environment availability');
    const alert = heading.closest('.ant-alert');
    expect(alert).not.toBeNull();
    expect(alert).toHaveClass('ant-alert-warning');
    expect(alert).toHaveTextContent('<img src=x onerror=alert(1)> **Bring your own runtime.**');

    const link = within(alert as HTMLElement).getByRole('link', {
      name: 'Read the environment guide',
    });
    expect(link).toHaveAttribute('href', 'https://agor.live/guide/environment-configuration');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    const [capabilitySummary] = screen.getAllByText(
      /This instance uses webhook-managed environments/
    );
    expect(
      heading.compareDocumentPosition(capabilitySummary) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).not.toBeInTheDocument();
  });
});
