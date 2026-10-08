import type { AgorClient, Branch, KnowledgeNamespace } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeBranch } from '../testUtils';

vi.mock('../../../utils/message', () => ({
  useThemedMessage: () => ({ showLoading: vi.fn(), showSuccess: vi.fn(), showError: vi.fn() }),
}));

import { KnowledgeTab } from './KnowledgeTab';

describe('KnowledgeTab', () => {
  it('opens the home namespace under the router basename', async () => {
    const namespace = {
      namespace_id: 'ns-1',
      slug: 'teammate-abc12345',
    } as unknown as KnowledgeNamespace;
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
    // Default test runtime has no /ui mount, so the href must be the plain
    // knowledge route; production prepends /ui via uiRouteHref.
    expect(link.getAttribute('href')).toMatch(/^(\/ui)?\/kb\/teammate-abc12345\/$/);
  });
});
