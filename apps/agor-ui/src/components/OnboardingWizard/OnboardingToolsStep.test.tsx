import type { MCPCatalogEntry } from '@agor/core/types';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { RequestedCatalogTool } from '../../utils/teammateBootstrapPrompt';
import { getTeammateTemplate, type TeammateTemplate } from '../../utils/teammateTemplates';
import { catalogEntry, makeCatalogClient } from '../Marketplace/MCPCatalogModal.test-fixtures';
import { OnboardingToolsStep } from './OnboardingToolsStep';

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
  const onPickedChange = vi.fn();
  const { client } = makeCatalogClient(entries);
  function Step() {
    const [picked, setPicked] = useState<RequestedCatalogTool[]>([]);
    return (
      <OnboardingToolsStep
        client={client}
        connected
        hasTeammate
        template={template}
        picked={picked}
        onPickedChange={(next) => {
          onPickedChange(next);
          setPicked(next);
        }}
      />
    );
  }
  render(<Step />);
  return onPickedChange;
}

const tile = (name: string) => screen.getByRole('button', { name });
const search = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText('Search tools'), { target: { value } });

describe('OnboardingToolsStep', () => {
  it('shows the whole catalog as a wall, narrowed by search and category', async () => {
    renderStep();
    expect(await screen.findByText('GitHub')).toBeInTheDocument();
    expect(tile('Notion')).toBeInTheDocument();
    expect(tile('Linear')).toBeInTheDocument();
    expect(screen.queryByText('Write and update docs.')).not.toBeInTheDocument();

    search('not');
    expect(tile('Notion')).toBeInTheDocument();
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();

    search('zzz');
    expect(screen.getByText('No tools match "zzz".')).toBeInTheDocument();

    search('');
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
    const order = () => screen.getAllByRole('button', { pressed: false }).map((el) => el.ariaLabel);
    renderStep();
    await screen.findByText('GitHub');
    expect(order()).toEqual(['Linear', 'Notion', 'GitHub']);
    cleanup();

    // Chief of staff: Notion by name, then productivity, then the rest.
    renderStep(getTeammateTemplate('chief-of-staff'));
    await screen.findByText('GitHub');
    expect(order()).toEqual(['Notion', 'Linear', 'GitHub']);

    // A category (or search) keeps the Catalog's order.
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Filter by category' }));
    fireEvent.click(await screen.findByTitle('Productivity'));
    await waitFor(() => expect(screen.queryByText('GitHub')).not.toBeInTheDocument());
    expect(order()).toEqual(['Linear', 'Notion']);
  });

  it('shows the Catalog logo (letter fallback), display title and category on each tile', async () => {
    renderStep();
    const notion = await screen.findByRole('button', { name: 'Notion' });
    expect(within(notion).getByRole('img', { name: 'Notion logo' })).toHaveAttribute(
      'src',
      'https://www.google.com/s2/favicons?domain=notion.so&sz=64'
    );
    expect(within(notion).getByText('Productivity')).toBeInTheDocument();
    const github = tile('GitHub');
    expect(github.querySelector('.ant-avatar-string')).toHaveTextContent('G');
    expect(within(github).getByText('Dev tools')).toBeInTheDocument();
  });

  it('toggles picks by Catalog id, keeps them through filtering and opens nothing', async () => {
    const onPickedChange = renderStep();
    const notion = await screen.findByRole('button', { name: 'Notion' });
    expect(notion).toHaveAccessibleDescription('Write and update docs.');
    expect(notion).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(notion);
    expect(notion).toHaveAttribute('aria-pressed', 'true');
    expect(onPickedChange).toHaveBeenLastCalledWith([
      { name: 'Notion', catalogEntryName: 'com.notion/mcp' },
    ]);
    expect(document.querySelector('.ant-drawer, [role="dialog"]')).toBeNull();

    search('lin');
    fireEvent.click(tile('Linear'));
    search('');
    expect(tile('Notion')).toHaveAttribute('aria-pressed', 'true');
    expect(tile('Linear')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(tile('Notion'));
    expect(tile('Notion')).toHaveAttribute('aria-pressed', 'false');
    expect(onPickedChange).toHaveBeenLastCalledWith([
      { name: 'Linear', catalogEntryName: 'app.linear/linear' },
    ]);
  });
});
