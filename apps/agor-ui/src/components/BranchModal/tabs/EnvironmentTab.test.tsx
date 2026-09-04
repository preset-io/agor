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

describe('EnvironmentTab deployment disclaimer', () => {
  beforeEach(() => {
    __setAuthConfigForTests({ requireAuth: true }, { managedEnvsExecutionMode: 'hybrid' });
  });

  it('preserves current behavior when the deployment disclaimer is absent', () => {
    renderTab();

    expect(screen.queryByText('Environment availability')).not.toBeInTheDocument();
    expect(
      screen.getAllByText(
        'This instance supports shell commands and URL webhooks for start, stop, nuke, and logs.'
      )
    ).not.toHaveLength(0);
  });

  it('renders sanitized Markdown above the dynamic capability summary', async () => {
    __setAuthConfigForTests(
      { requireAuth: true },
      { managedEnvsExecutionMode: 'webhook-only' },
      {
        environmentDisclaimerMarkdown:
          '<img src=x onerror=alert(1)>\n\n**Bring your own runtime.** [Read the environment guide](https://agor.live/guide/environment-configuration) [unsafe](javascript:alert(1))',
      }
    );

    const { container } = renderTab();

    const heading = screen.getByText('Environment availability');
    const alert = heading.closest('.ant-alert');
    expect(alert).not.toBeNull();
    expect(alert).toHaveClass('ant-alert-warning');
    expect(await within(alert as HTMLElement).findByText('Bring your own runtime.')).toBeVisible();
    expect(alert).not.toHaveTextContent('**Bring your own runtime.**');

    const link = await within(alert as HTMLElement).findByRole('link', {
      name: 'Read the environment guide',
    });
    expect(link).toHaveAttribute('href', 'https://agor.live/guide/environment-configuration');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));

    const [capabilitySummary] = screen.getAllByText(
      /This instance uses webhook-managed environments/
    );
    expect(
      heading.compareDocumentPosition(capabilitySummary) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).not.toBeInTheDocument();
    expect(container.querySelector('script, iframe, object, embed')).not.toBeInTheDocument();
    expect(
      within(alert as HTMLElement).queryByRole('link', { name: 'unsafe' })
    ).not.toBeInTheDocument();
  });
});
