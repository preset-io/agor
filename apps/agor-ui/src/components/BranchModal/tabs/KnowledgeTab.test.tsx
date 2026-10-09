import type { AgorClient, Branch, KnowledgeNamespace } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeBranch } from '../testUtils';

vi.mock('../../../utils/message', () => ({
  useThemedMessage: () => ({ showLoading: vi.fn(), showSuccess: vi.fn(), showError: vi.fn() }),
}));

import { KnowledgeTab } from './KnowledgeTab';

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
