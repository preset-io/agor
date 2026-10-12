import type { MCPCatalogEntry } from '@agor/core/types';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getTeammateTemplate, type TeammateTemplate } from '../../utils/teammateTemplates';
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
    icon_url: 'https://www.google.com/s2/favicons?domain=notion.so&sz=64',
    category: 'productivity',
    benefit: 'Write and update docs.',
  },
  { ...catalogEntry, name: 'app.linear/linear', title: 'Linear', category: 'productivity' },
];

function renderStep(template?: TeammateTemplate) {
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
      template={template}
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

    // A category with nothing in it must not echo an empty search back as `""`.
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Filter by category' }));
    fireEvent.click(await screen.findByTitle('Observability'));
    expect(await screen.findByText('No tools to show.')).toBeInTheDocument();
  });

  it("lists the picked template's tools first and hides none", async () => {
    const order = () =>
      screen.getAllByRole('button', { name: /: view details$/ }).map((el) => el.ariaLabel);
    renderStep();
    await screen.findByText('GitHub');
    expect(order()).toEqual([
      'Linear: view details',
      'Notion: view details',
      'GitHub: view details',
    ]);
    cleanup();

    // Chief of staff: Notion by name, then productivity, then the rest.
    renderStep(getTeammateTemplate('chief-of-staff'));
    await screen.findByText('GitHub');
    expect(order()).toEqual([
      'Notion: view details',
      'Linear: view details',
      'GitHub: view details',
    ]);

    // A category (or search) keeps the Catalog's order.
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Filter by category' }));
    fireEvent.click(await screen.findByTitle('Productivity'));
    await waitFor(() => expect(screen.queryByText('GitHub')).not.toBeInTheDocument());
    expect(order()).toEqual(['Linear: view details', 'Notion: view details']);
  });

  it('shows the Catalog logo (letter fallback), display title and category on each tile', async () => {
    renderStep();
    const notion = await screen.findByRole('button', { name: 'Notion: view details' });
    expect(within(notion).getByRole('img', { name: 'Notion logo' })).toHaveAttribute(
      'src',
      'https://www.google.com/s2/favicons?domain=notion.so&sz=64'
    );
    expect(within(notion).getByText('Productivity')).toBeInTheDocument();
    const github = tile('GitHub');
    expect(github.querySelector('.ant-avatar-string')).toHaveTextContent('G');
    expect(within(github).getByText('Dev tools')).toBeInTheDocument();
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
