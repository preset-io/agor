import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AutocompleteTextarea, type KbDocMention } from './AutocompleteTextarea';

const renderSlashAutocomplete = () => {
  const Harness = () => {
    const [value, setValue] = useState('');

    return (
      <AutocompleteTextarea
        value={value}
        onChange={setValue}
        placeholder="Prompt"
        client={null}
        sessionId={null}
        userById={new Map()}
        slashCommands={['alpha', 'beta']}
      />
    );
  };

  render(<Harness />);
  return screen.getByPlaceholderText('Prompt') as HTMLTextAreaElement;
};

const createMockClient = () => {
  const filesFindAll = vi.fn(async () => [{ path: 'src/architecture.ts', type: 'file' }]);
  const kbSearchFind = vi.fn(async () => [
    {
      document: {
        document_id: '0190a000-0000-7000-8000-0000000000aa',
        namespace_id: '0190a000-0000-7000-8000-0000000000bb',
        path: 'guides/architecture.md',
        uri: 'agor://kb/global/guides/architecture.md',
        title: 'Architecture Overview',
        kind: 'doc',
        visibility: 'public',
        status: 'published',
        edit_policy: 'editors',
        current_version_id: null,
        metadata: null,
        created_by: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_by: null,
        updated_at: new Date('2026-01-02T00:00:00Z'),
        archived: false,
        archived_at: null,
      },
      namespace: { slug: 'global' },
      score: 1,
      mode: 'text',
      snippet: '',
      chunks: [],
    },
  ]);
  const kbDocumentsFind = vi.fn(async () => [
    {
      document_id: '0190a000-0000-7000-8000-0000000000cc',
      namespace_id: '0190a000-0000-7000-8000-0000000000bb',
      path: 'runbooks/recent.md',
      uri: 'agor://kb/team/runbooks/recent.md',
      title: 'Recent Runbook',
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-03T00:00:00Z'),
    },
  ]);

  const client = {
    service: vi.fn((name: string) => {
      if (name === 'files') return { findAll: filesFindAll };
      if (name === 'kb/search') return { find: kbSearchFind };
      if (name === 'kb/documents') return { find: kbDocumentsFind };
      throw new Error(`Unexpected service ${name}`);
    }),
  };

  return { client, filesFindAll, kbSearchFind, kbDocumentsFind };
};

const renderMentionAutocomplete = (
  client: ReturnType<typeof createMockClient>['client'],
  options: {
    enableKnowledgeMentions?: boolean;
    kbLinkTarget?: 'stable-uri' | 'absolute-route';
    kbDocs?: KbDocMention[];
  } = {}
) => {
  const Harness = () => {
    const [value, setValue] = useState('');

    return (
      <AutocompleteTextarea
        value={value}
        onChange={setValue}
        placeholder="Prompt"
        client={client as never}
        sessionId={'0190a000-0000-7000-8000-000000000001' as never}
        userById={new Map()}
        enableKnowledgeMentions={options.enableKnowledgeMentions}
        kbLinkTarget={options.kbLinkTarget}
        kbDocs={options.kbDocs}
      />
    );
  };

  render(<Harness />);
  return screen.getByPlaceholderText('Prompt') as HTMLTextAreaElement;
};

const waitForDebounce = () => new Promise((resolve) => setTimeout(resolve, 350));
const waitForStateUpdate = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AutocompleteTextarea', () => {
  it('selects the default highlighted autocomplete item with Enter', async () => {
    const textarea = renderSlashAutocomplete();

    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });

    await screen.findByText('alpha');
    expect(screen.getByText('beta')).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(textarea).toHaveValue('/alpha ');
    });
  });

  it('navigates autocomplete options upward with arrow keys', async () => {
    const textarea = renderSlashAutocomplete();

    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });

    await screen.findByText('alpha');
    expect(screen.getByText('beta')).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    await waitForStateUpdate();
    fireEvent.keyDown(textarea, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    await waitForStateUpdate();
    fireEvent.keyDown(textarea, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, which: 38 });
    await waitForStateUpdate();
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(textarea).toHaveValue('/alpha ');
    });
  });

  it('combines Knowledge and file suggestions for @ queries without changing file search', async () => {
    const { client, filesFindAll, kbSearchFind } = createMockClient();
    const textarea = renderMentionAutocomplete(client, {
      enableKnowledgeMentions: true,
      kbLinkTarget: 'absolute-route',
    });

    fireEvent.change(textarea, { target: { value: '@arc', selectionStart: 4 } });
    await waitForDebounce();

    await screen.findByText('KNOWLEDGE BASE');
    expect(screen.getByText('Architecture Overview')).toBeInTheDocument();
    expect(screen.queryByText('guides/architecture.md')).not.toBeInTheDocument();
    expect(screen.getByText('FILES & FOLDERS')).toBeInTheDocument();
    expect(screen.getByText('src/architecture.ts')).toBeInTheDocument();
    expect(document.body.textContent?.indexOf('FILES & FOLDERS')).toBeLessThan(
      document.body.textContent?.indexOf('KNOWLEDGE BASE') ?? Number.POSITIVE_INFINITY
    );
    expect(kbSearchFind).toHaveBeenCalledWith({
      query: { q: 'arc', mode: 'text', limit: 8, include_chunks: false },
    });
    expect(filesFindAll).toHaveBeenCalledWith({
      query: { sessionId: '0190a000-0000-7000-8000-000000000001', search: 'arc' },
    });
  });

  it('inserts a clickable route link for prompt-composer KB selections', async () => {
    const { client } = createMockClient();
    const textarea = renderMentionAutocomplete(client, {
      enableKnowledgeMentions: true,
      kbLinkTarget: 'absolute-route',
    });

    fireEvent.change(textarea, { target: { value: 'Read @arc', selectionStart: 9 } });
    await waitForDebounce();

    fireEvent.click(await screen.findByText('Architecture Overview'));

    await waitFor(() => {
      expect(textarea).toHaveValue(
        `Read [Architecture Overview](${window.location.origin}/kb/global/guides/architecture.md) `
      );
    });
  });

  it('does not search Knowledge unless explicitly enabled', async () => {
    const { client, kbSearchFind, kbDocumentsFind } = createMockClient();
    const textarea = renderMentionAutocomplete(client);

    fireEvent.change(textarea, { target: { value: '@arc', selectionStart: 4 } });
    await waitForDebounce();

    expect(screen.queryByText('KNOWLEDGE BASE')).not.toBeInTheDocument();
    expect(kbSearchFind).not.toHaveBeenCalled();
    expect(kbDocumentsFind).not.toHaveBeenCalled();
  });

  it('does not fetch broad Knowledge lists for empty @ queries', async () => {
    const { client, kbSearchFind, kbDocumentsFind } = createMockClient();
    const textarea = renderMentionAutocomplete(client, { enableKnowledgeMentions: true });

    fireEvent.change(textarea, { target: { value: '@', selectionStart: 1 } });
    await waitForDebounce();

    expect(screen.queryByText('Recent Runbook')).not.toBeInTheDocument();
    expect(kbDocumentsFind).not.toHaveBeenCalled();
    expect(kbSearchFind).not.toHaveBeenCalled();
  });

  it('inserts stable agor:// links for provided KB docs, without live KB search', async () => {
    const { client, kbSearchFind, kbDocumentsFind } = createMockClient();
    const kbDocs: KbDocMention[] = [
      {
        title: 'Architecture Overview',
        documentId: '0190a000-0000-7000-8000-0000000000aa' as never,
        path: 'guides/architecture.md',
        uri: 'agor://kb/global/guides/architecture.md',
        routePath: '/kb/global/guides/architecture.md',
      },
    ];
    const textarea = renderMentionAutocomplete(client, { kbDocs });

    fireEvent.change(textarea, { target: { value: 'Read @arc', selectionStart: 9 } });
    await waitForDebounce();

    fireEvent.click(await screen.findByText('Architecture Overview'));

    await waitFor(() => {
      expect(textarea).toHaveValue(
        'Read [Architecture Overview](agor://kb/document/0190a000-0000-7000-8000-0000000000aa) '
      );
    });
    expect(kbSearchFind).not.toHaveBeenCalled();
    expect(kbDocumentsFind).not.toHaveBeenCalled();
  });
});
