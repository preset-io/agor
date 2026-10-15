import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { makeSession, withTestAuthority } from '../../test/harness';
import { ForkSpawnModal } from './ForkSpawnModal';

vi.mock('../AutocompleteTextarea', () => ({ AutocompleteTextarea: () => <textarea /> }));

describe('spawn MCP preview read failures', () => {
  withTestAuthority();

  it('replaces a rejected parent MCP read with a retry instead of loading forever', async () => {
    const parent = makeSession('parent', 'branch', { agentic_tool: 'claude-code' });
    agorStore.getState().setMap('sessionById', new Map([['parent', parent]]));
    const find = vi.fn().mockRejectedValueOnce(new Error('read unavailable')).mockResolvedValue([]);
    const client = {
      service: (name: string) => ({
        find: name === 'session-mcp-servers' ? find : vi.fn().mockResolvedValue([]),
      }),
    } as unknown as AgorClient;
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ForkSpawnModal
        open
        action="spawn"
        session={parent}
        client={client}
        initialPrompt="Delegate"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        userById={new Map()}
      />
    );
    fireEvent.click(screen.getByText('Custom config'));
    await waitFor(() => expect(find).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId('mcp-chip')).not.toHaveTextContent('Loading'));
    fireEvent.click(screen.getByTestId('mcp-chip'));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('mcp-chip')).toHaveTextContent('No MCP servers'));
    fireEvent.click(screen.getByRole('button', { name: 'Spawn Session' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onConfirm.mock.calls[0][0]).not.toHaveProperty('mcpServerIds');
  });
});
