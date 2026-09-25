import type { FileListItem, GitFileStatus } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { DiffBlock } from '../ToolUseRenderer/renderers/DiffBlock';
import { FileCollection } from './FileCollection';

const statuses: GitFileStatus[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'conflicted',
  'ignored',
  'untracked',
];
const files: FileListItem[] = statuses.map((gitStatus) => ({
  path: `${gitStatus}.txt`,
  title: gitStatus,
  size: 10,
  lastModified: '',
  isText: true,
  gitStatus,
}));

it.each([false, true])(
  'renders non-color status labels and optional actions (dark: %s)',
  async (dark) => {
    render(
      <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
        <App>
          <FileCollection files={files} onFileClick={vi.fn()} />
        </App>
      </ConfigProvider>
    );
    for (const status of statuses) {
      expect(
        screen.getByRole('img', { name: status[0].toUpperCase() + status.slice(1) })
      ).toBeVisible();
    }
    expect(screen.queryByRole('button', { name: /^Download / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy path added.txt' })).toBeVisible();
  }
);

it('retains a deleted file and a new directory with the same name', async () => {
  const onFileClick = vi.fn();
  render(
    <App>
      <FileCollection
        files={[
          { ...files[0], path: 'replaced/child.txt', title: 'child' },
          { ...files[2], path: 'replaced', title: 'replaced' },
        ]}
        onFileClick={onFileClick}
      />
    </App>
  );
  fireEvent.change(screen.getByPlaceholderText('Search files...'), {
    target: { value: 'replaced' },
  });
  await waitFor(() => expect(screen.getByText('child.txt')).toBeVisible());
  await userEvent.click(screen.getByText('child.txt'));
  expect(onFileClick).toHaveBeenCalledWith(expect.objectContaining({ path: 'replaced/child.txt' }));
  expect(screen.getByRole('img', { name: 'Deleted' })).toBeVisible();
});

it('supports keyboard diff disclosure and limits a whole-file replacement', async () => {
  const before = Array.from({ length: 10000 }, (_, n) => `before ${n}`).join('\n');
  const after = Array.from({ length: 10000 }, (_, n) => `after ${n}`).join('\n');
  render(
    <App>
      <DiffBlock
        filePath="large.txt"
        operationType="edit"
        oldContent={before}
        newContent={after}
        rawContentKind="full-file"
      />
    </App>
  );
  expect(screen.getByText('Diff preview limited')).toBeVisible();
  const toggle = screen.getByRole('button', { name: 'Collapse diff large.txt' });
  toggle.focus();
  await act(async () => userEvent.keyboard('{Enter}'));
  expect(screen.queryByText('Diff preview limited')).toBeNull();
  await act(async () => userEvent.keyboard(' '));
  expect(screen.getByText('Diff preview limited')).toBeVisible();
});
