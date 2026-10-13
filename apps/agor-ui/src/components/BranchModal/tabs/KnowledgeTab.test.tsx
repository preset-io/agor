import type { AgorClient, Branch, KnowledgeNamespace } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBranch, makeTeammateBranch, renderWithApp } from '../testUtils';
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
        "Couldn't save the knowledge settings. You don't have permission to do this. (Forbidden)"
      )
    );
  });
});

const SLUG = 'teammate-abc12345';

async function renderOpenLink(): Promise<string | null> {
  const namespace = { namespace_id: 'ns-1', slug: SLUG } as unknown as KnowledgeNamespace;
  const client = {
    service: () => ({
      find: async () => [namespace],
      get: async () => namespace,
    }),
  } as unknown as AgorClient;
  const branch = makeBranch({
    custom_context: {
      teammate: { kind: 'teammate', kb: { primary_namespace_id: 'ns-1', grants: [] } },
    },
  } as Partial<Branch>);

  render(<KnowledgeTab branch={branch} client={client} canEdit={false} />);
  const link = await screen.findByRole('link', { name: /Open in Knowledge/ });
  return link.getAttribute('href');
}

describe('KnowledgeTab Open in Knowledge link', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefixes the /ui mount when served by the daemon', async () => {
    vi.stubEnv('BASE_URL', '/ui/');
    expect(await renderOpenLink()).toBe(`/ui/kb/${SLUG}/`);
  });

  it('uses the plain route when mounted at the root', async () => {
    expect(await renderOpenLink()).toBe(`/kb/${SLUG}/`);
  });
});
