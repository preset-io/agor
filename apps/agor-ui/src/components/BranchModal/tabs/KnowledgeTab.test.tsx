import type { AgorClient, KnowledgeNamespace } from '@agor-live/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTeammateBranch, renderWithApp } from '../testUtils';
import { KnowledgeTab } from './KnowledgeTab';

const messageMocks = vi.hoisted(() => ({ showError: vi.fn(), showSuccess: vi.fn() }));
vi.mock('@/utils/message', () => ({
  useThemedMessage: () => messageMocks,
}));

const namespace = {
  namespace_id: '01900000-0000-7000-8000-000000000001',
  slug: 'team',
  display_name: 'Team',
  effective_permission: 'own',
  visibility_default: 'public',
} as unknown as KnowledgeNamespace;

function renderTab({
  ensure = vi.fn(),
  patch = vi.fn(),
}: {
  ensure?: ReturnType<typeof vi.fn>;
  patch?: ReturnType<typeof vi.fn>;
}) {
  const branch = makeTeammateBranch({}, {
    kb: {
      primary_namespace_id: namespace.namespace_id,
      primary_namespace_slug: namespace.slug,
      global_access: 'write',
      grants: [],
    },
  } as never);
  const client = {
    service: (path: string) => {
      if (path === 'kb/namespaces')
        return { find: async () => [namespace], get: async () => namespace };
      return { ensureTeammateKnowledgeNamespace: ensure, patch };
    },
  } as unknown as AgorClient;
  renderWithApp(<KnowledgeTab branch={branch} client={client} canEdit />);
}

describe('KnowledgeTab failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a repair failure inline only, with Try again', async () => {
    const ensure = vi
      .fn()
      .mockRejectedValueOnce(new Error('Internal Server Error'))
      .mockResolvedValue({ namespace, branch: makeTeammateBranch() });
    renderTab({ ensure });

    fireEvent.click(await screen.findByRole('button', { name: 'Repair namespace' }));

    expect(
      await screen.findByText("Couldn't repair this teammate's knowledge.")
    ).toBeInTheDocument();
    expect(messageMocks.showError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() =>
      expect(screen.queryByText("Couldn't repair this teammate's knowledge.")).toBeNull()
    );
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(messageMocks.showSuccess).toHaveBeenCalledWith("This teammate's knowledge is ready.");
  });

  it('names the knowledge settings when saving the policy fails', async () => {
    const patch = vi.fn(async () => {
      throw Object.assign(new Error('Forbidden'), { name: 'Forbidden', code: 403 });
    });
    renderTab({ patch });

    fireEvent.click(await screen.findByRole('button', { name: 'Save policy' }));

    await waitFor(() =>
      expect(messageMocks.showError).toHaveBeenCalledWith(
        "Couldn't save the knowledge settings. You don't have permission to do this."
      )
    );
  });
});
