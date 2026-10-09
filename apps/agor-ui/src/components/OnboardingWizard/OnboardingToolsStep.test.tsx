import type { MCPCatalogEntry } from '@agor/core/types';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  catalogEntry,
  catalogUser,
  makeCatalogClient,
} from '../Marketplace/MCPCatalogModal.test-fixtures';
import { OnboardingToolsStep } from './OnboardingToolsStep';

vi.mock('../Marketplace/CatalogTab', () => ({
  CatalogTab: ({ context }: { context: { mode: string; entryName: string } }) => (
    <div data-testid="catalog-drawer" data-mode={context.mode} data-entry={context.entryName} />
  ),
}));

const entries: MCPCatalogEntry[] = [
  { ...catalogEntry, name: 'io.github.github/github-mcp-server', title: 'GitHub' },
  {
    ...catalogEntry,
    name: 'com.notion/mcp',
    title: 'Notion',
    category: 'productivity',
    benefit: 'Write and update docs.',
  },
  { ...catalogEntry, name: 'app.linear/linear', title: 'Linear', category: 'productivity' },
];

function renderStep() {
  const api = makeCatalogClient(entries);
  vi.mocked(api.client.service('mcp-catalog/readiness').get).mockImplementation(
    async (key: string) =>
      ({
        catalog_key: key,
        state: key === 'com.notion/mcp' ? 'installed_ready' : 'oauth_required',
      }) as never
  );
  render(
    <OnboardingToolsStep
      client={api.client}
      user={catalogUser}
      connected
      authGeneration={1}
      onConnected={vi.fn()}
    />
  );
  return api;
}

const tile = (name: string) => screen.getByRole('button', { name: `${name}: view details` });

describe('OnboardingToolsStep', () => {
  it('shows the whole catalog as a wall, narrowed by search and category', async () => {
    renderStep();
    expect(await screen.findByText('GitHub')).toBeInTheDocument();
    expect(tile('Notion')).toBeInTheDocument();
    expect(tile('Linear')).toBeInTheDocument();
    expect(screen.queryByText('Write and update docs.')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search tools'), { target: { value: 'not' } });
    expect(tile('Notion')).toBeInTheDocument();
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search tools'), { target: { value: 'zzz' } });
    expect(screen.getByText('No tools match "zzz".')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search tools'), { target: { value: '' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Filter by category' }));
    fireEvent.click(await screen.findByTitle('Productivity'));
    await waitFor(() => expect(screen.queryByText('GitHub')).not.toBeInTheDocument());
    expect(tile('Notion')).toBeInTheDocument();
    expect(tile('Linear')).toBeInTheDocument();
  });

  it('marks connected tools from caller-scoped readiness', async () => {
    renderStep();
    await waitFor(() => expect(within(tile('Notion')).getByText('Connected')).toBeInTheDocument());
    expect(within(tile('Linear')).queryByText('Connected')).not.toBeInTheDocument();
  });

  it('opens the shared Catalog drawer in onboarding mode from a tile', async () => {
    renderStep();
    expect(screen.queryByTestId('catalog-drawer')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Linear: view details' }));
    const drawer = screen.getByTestId('catalog-drawer');
    expect(drawer).toHaveAttribute('data-mode', 'onboarding');
    expect(drawer).toHaveAttribute('data-entry', 'app.linear/linear');
  });
});
