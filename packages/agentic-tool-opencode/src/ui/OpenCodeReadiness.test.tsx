// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeReadiness } from './OpenCodeReadiness.js';

function clientWithCatalog(providers: Array<{ availableForSelection: boolean }>) {
  const find = vi.fn().mockResolvedValue({ runtimeVersion: '1.14.33', providers });
  return {
    find,
    client: { service: vi.fn(() => ({ find })) },
  };
}

function renderStatus(client: unknown, canLoadReadiness = true) {
  return render(
    <OpenCodeReadiness client={client as never} canLoadReadiness={canLoadReadiness}>
      {(status) => (
        <output>
          {status.tone}:{status.label}
        </output>
      )}
    </OpenCodeReadiness>
  );
}

describe('OpenCodeReadiness', () => {
  it.each([
    [true, 'positive:Available'],
    [false, 'neutral:Not available'],
  ])(
    'reports resolved provider availability without another catalog path',
    async (available, label) => {
      const { client, find } = clientWithCatalog([{ availableForSelection: available }]);

      renderStatus(client);

      expect(screen.getByText('neutral:Checking availability')).toBeInTheDocument();
      expect(await screen.findByText(label)).toBeInTheDocument();
      expect(find).toHaveBeenCalledOnce();
    }
  );

  it('reports an unavailable status when the shared catalog read fails', async () => {
    const find = vi.fn().mockRejectedValue(new Error('catalog unavailable'));

    renderStatus({ service: vi.fn(() => ({ find })) });

    expect(await screen.findByText('neutral:Status unavailable')).toBeInTheDocument();
  });

  it('does not read caller-scoped availability for another user', () => {
    const { client, find } = clientWithCatalog([{ availableForSelection: true }]);

    renderStatus(client, false);

    expect(screen.getByText('neutral:Status unavailable')).toBeInTheDocument();
    expect(find).not.toHaveBeenCalled();
  });
});
