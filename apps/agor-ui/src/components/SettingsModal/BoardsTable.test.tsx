import type { AgorClient, Board, User } from '@agor-live/client';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFeathersClient, mount, withTestAuthority } from '../../test/harness';
import { BoardsTable } from './BoardsTable';
import { renderWithSettingsShell } from './settingsDrillTestUtils';

const member = { user_id: 'me', email: 'me@example.test', role: 'member' } as User;
const viewer = { user_id: 'viewer', email: 'viewer@example.test', role: 'viewer' } as User;

describe('BoardsTable create guard', () => {
  it('asks before Back discards a picked background preset', async () => {
    renderWithSettingsShell(
      <BoardsTable
        client={null}
        boardById={new Map()}
        branchById={new Map()}
        currentUser={member}
      />,
      'boards'
    );
    const confirms = () => document.querySelectorAll('.ant-modal-confirm').length;
    fireEvent.click(screen.getByRole('button', { name: /New Board/ }));
    fireEvent.click(await screen.findByRole('tab', { name: 'CSS' }));
    fireEvent.click(screen.getByText('Preset'));
    // A preset applies via setFieldsValue, which fires no onValuesChange.
    fireEvent.click(screen.getAllByRole('button', { name: /\(/ })[0]);
    fireEvent.click(screen.getByText('Boards'));
    await waitFor(() => expect(confirms()).toBe(1));
  });
});

const board = { board_id: 'board-1', name: 'Roadmap', slug: 'roadmap' } as unknown as Board;

withTestAuthority('me:member:1', { dataAuthority: false });

afterEach(() => vi.restoreAllMocks());

function renderTable(boards: Record<string, unknown>, currentUser: User = member) {
  const fake = fakeFeathersClient({ 'session-counts': { find: () => [] } });
  const client = Object.create(fake.client) as AgorClient;
  client.service = ((path: string) =>
    path === 'boards' ? boards : fake.client.service(path)) as AgorClient['service'];
  mount(
    <BoardsTable
      client={client}
      boardById={new Map([[board.board_id, board]])}
      branchById={new Map()}
      currentUser={currentUser}
    />
  );
}

async function importFile(name: string, content: string) {
  const file = { name, text: async () => content };
  let picker: HTMLInputElement | undefined;
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement
  ) {
    picker = this;
  });
  fireEvent.click(screen.getByRole('button', { name: /import/i }));
  Object.defineProperty(picker, 'files', { value: [file] });
  await act(async () => {
    picker?.onchange?.({ target: picker } as unknown as Event);
  });
}

it('names the export that failed', async () => {
  renderTable({ toYaml: vi.fn().mockRejectedValue(new Error('boom')) });
  const row = (await screen.findByText('Roadmap')).closest('tr') as HTMLElement;
  const exportButton = within(row)
    .getAllByRole('button')
    .find((button) => button.querySelector('.anticon-download')) as HTMLElement;
  fireEvent.click(exportButton);
  expect(await screen.findByText("Couldn't export the board. (boom)")).toBeInTheDocument();
});

it('says an unparseable JSON import file is not valid JSON without calling Agor', async () => {
  const fromBlob = vi.fn();
  renderTable({ fromBlob });
  await screen.findByText('Roadmap');
  await importFile('board.json', '{not json');
  expect(
    await screen.findByText("Couldn't import the board. The file isn't valid JSON.")
  ).toBeInTheDocument();
  expect(fromBlob).not.toHaveBeenCalled();
});

it('keeps the skipped-items summary on screen after an import', async () => {
  renderTable({
    fromYaml: vi.fn().mockResolvedValue({
      ...board,
      name: 'Imported',
      import_skipped: [
        { reason: 'unreadable', object_type: 'card', object_id: 'x', detail: 'bad' },
      ],
    }),
  });
  await screen.findByText('Roadmap');
  await importFile('board.yaml', 'name: Imported');
  expect(
    await screen.findByText(
      'Imported Imported, but not everything came across: 1 object was unsupported or malformed and was skipped.'
    )
  ).toBeInTheDocument();
});

it('shows a viewer the board actions disabled, keeping Export', async () => {
  renderTable({}, viewer);
  const row = (await screen.findByText('Roadmap')).closest('tr') as HTMLElement;
  // DOM queries: role queries trip jsdom's border-shorthand parser on disabled antd buttons.
  const button = (label: string) => screen.getByText(label).closest('button') as HTMLElement;
  expect(button('New Board')).toBeDisabled();
  expect(button('Import Board')).toBeDisabled();
  const rowButton = (icon: string) =>
    row.querySelector(`.anticon-${icon}`)?.closest('button') as HTMLElement;
  for (const icon of ['inbox', 'copy', 'edit', 'delete']) {
    expect(rowButton(icon)).toBeDisabled();
  }
  expect(rowButton('download')).toBeEnabled();
});
