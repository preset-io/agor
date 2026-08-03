// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeModelSelector } from './OpenCodeModelSelector.js';

const catalog = {
  runtimeVersion: '1.14.33',
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      runtimeAvailable: true,
      suggestedModel: 'gpt-5',
      models: [
        { id: 'gpt-5', name: 'GPT-5', status: 'active' },
        { id: 'gpt-4-old', name: 'GPT-4 old', status: 'deprecated' },
      ],
    },
  ],
};

const nativeScaleCatalog = {
  runtimeVersion: '1.14.33',
  providers: Array.from({ length: 4 }, (_, providerIndex) => ({
    id: `provider-${providerIndex}`,
    name: `Provider ${providerIndex}`,
    runtimeAvailable: true,
    models: Array.from({ length: 80 }, (_, modelIndex) => ({
      id: `model-${modelIndex}`,
      name: `Provider ${providerIndex} model ${modelIndex}`,
      status: 'active',
    })),
  })),
};

function clientWithCatalog(result: unknown = catalog) {
  const find = vi.fn().mockResolvedValue(result);
  return {
    find,
    client: {
      service: vi.fn(() => ({ find })),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('OpenCodeModelSelector', () => {
  it('loads the authenticated known catalog and selects an exact pair', async () => {
    const onChange = vi.fn();
    const { client, find } = clientWithCatalog();
    render(
      <OpenCodeModelSelector client={client as never} branchId="branch-1" onChange={onChange} />
    );

    const providerSelect = await screen.findByLabelText('OpenCode provider');
    expect(find).toHaveBeenCalledWith();

    fireEvent.mouseDown(providerSelect);
    fireEvent.click(await screen.findByText('OpenAI'));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByLabelText('OpenCode model'));
    fireEvent.click(await screen.findByText('GPT-5'));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'openai', model: 'gpt-5' });
  });

  it('applies a safe catalog suggestion only while the selection is empty', async () => {
    const onChange = vi.fn();
    const { client } = clientWithCatalog({
      ...catalog,
      suggestedSelection: { providerId: 'openai', modelId: 'gpt-5' },
    });
    const { rerender } = render(
      <OpenCodeModelSelector client={client as never} onChange={onChange} />
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' })
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    rerender(
      <OpenCodeModelSelector
        value={{ provider: 'manual', model: 'stored' }}
        client={client as never}
        onChange={onChange}
      />
    );
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('distinguishes and disables unavailable known providers in normal selection', async () => {
    const onChange = vi.fn();
    const { client } = clientWithCatalog({
      ...catalog,
      providers: [
        ...catalog.providers,
        {
          id: 'catalog-only',
          name: 'Catalog only',
          runtimeAvailable: false,
          models: [{ id: 'manual-model', name: 'Manual model', status: 'active' }],
        },
      ],
    });
    render(<OpenCodeModelSelector client={client as never} onChange={onChange} />);

    const providerSelect = await screen.findByLabelText('OpenCode provider');
    fireEvent.mouseDown(providerSelect);
    const unavailable = await screen.findByText('Catalog only · unavailable');
    expect(unavailable.closest('.ant-select-item-option')).toHaveClass(
      'ant-select-item-option-disabled'
    );
    fireEvent.click(unavailable);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('OpenCode model')).toBeDisabled();
    expect(screen.getByRole('button', { name: /enter exact ids manually/i })).toBeInTheDocument();
  });

  it('keeps a 320-model compact catalog bounded and emits one searched exact pair', async () => {
    const onChange = vi.fn();
    const { client } = clientWithCatalog(nativeScaleCatalog);
    render(<OpenCodeModelSelector client={client as never} onChange={onChange} compact />);

    const selector = await screen.findByLabelText('OpenCode model');
    expect(screen.queryByText('Provider 3 model 79')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Provider 3 model 79' })).not.toBeInTheDocument();

    fireEvent.mouseDown(selector);
    fireEvent.change(selector, { target: { value: 'Provider 3 model 79' } });
    fireEvent.click(await screen.findByText('Provider 3 model 79'));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({ provider: 'provider-3', model: 'model-79' });
  });

  it('renders a stored compact pair honestly while its catalog is loading', () => {
    const pending = deferred<typeof catalog>();
    const { client } = clientWithCatalog(pending.promise);

    render(
      <OpenCodeModelSelector
        value={{ provider: 'legacy', model: 'stored' }}
        client={client as never}
        compact
      />
    );

    expect(screen.getByText('legacy/stored')).toBeInTheDocument();
    expect(screen.queryByText(/legacy\/stored \(unavailable\)/i)).not.toBeInTheDocument();
  });

  it('keeps a stored compact pair honest after catalog refresh fails', async () => {
    const find = vi.fn().mockRejectedValue(new Error('catalog unavailable'));
    const client = { service: vi.fn(() => ({ find })) };

    render(
      <OpenCodeModelSelector
        value={{ provider: 'legacy', model: 'stored' }}
        client={client as never}
        compact
      />
    );

    expect(await screen.findByLabelText('OpenCode model warning')).toBeInTheDocument();
    expect(screen.getByText('legacy/stored')).toBeInTheDocument();
    expect(screen.queryByText(/legacy\/stored \(unavailable\)/i)).not.toBeInTheDocument();
  });

  it('keeps a foreign owner stored compact pair private without calling it unavailable', () => {
    const { client, find } = clientWithCatalog();

    render(
      <OpenCodeModelSelector
        value={{ provider: 'private-provider', model: 'private-model' }}
        client={client as never}
        catalogEnabled={false}
        compact
      />
    );

    expect(find).not.toHaveBeenCalled();
    expect(screen.getByText('private-provider/private-model')).toBeInTheDocument();
    expect(screen.queryByText(/\(unavailable\)/i)).not.toBeInTheDocument();
  });

  it('does not refetch the user-scoped catalog when only the branch changes', async () => {
    const { client, find } = clientWithCatalog();
    const { rerender } = render(
      <OpenCodeModelSelector
        value={{ provider: 'openai', model: 'gpt-5' }}
        client={client as never}
        branchId="branch-a"
        compact
      />
    );

    expect(await screen.findByText('GPT-5')).toBeInTheDocument();
    rerender(
      <OpenCodeModelSelector
        value={{ provider: 'openai', model: 'gpt-5' }}
        client={client as never}
        branchId="branch-b"
        compact
      />
    );

    expect(screen.getByText('GPT-5')).toBeInTheDocument();
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('does not call an unlisted stored exact pair unavailable', async () => {
    const { client } = clientWithCatalog();

    render(
      <OpenCodeModelSelector
        value={{ provider: 'legacy', model: 'removed' }}
        client={client as never}
        compact
      />
    );

    expect(await screen.findByText('legacy/removed')).toBeInTheDocument();
    expect(screen.queryByText(/legacy\/removed \(unavailable\)/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('OpenCode model warning')).not.toBeInTheDocument();
  });

  it('labels a known stored pair unavailable when its provider is not configured', async () => {
    const { client } = clientWithCatalog({
      ...catalog,
      providers: catalog.providers.map((provider) => ({
        ...provider,
        runtimeAvailable: false,
      })),
    });

    render(
      <OpenCodeModelSelector
        value={{ provider: 'openai', model: 'gpt-5' }}
        client={client as never}
        compact
      />
    );

    expect(await screen.findByText('GPT-5 · provider unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('OpenCode model warning')).toBeInTheDocument();
  });

  it('keeps manual exact entry available without an automatic default when refresh fails', async () => {
    const onChange = vi.fn();
    const find = vi.fn().mockRejectedValue(new Error('private path /secret should not render'));
    const client = { service: vi.fn(() => ({ find })) };
    render(<OpenCodeModelSelector client={client as never} onChange={onChange} />);

    expect(await screen.findByText(/could not refresh the known model catalog/i)).toBeTruthy();
    expect(screen.queryByText(/private path|secret/i)).toBeNull();

    expect(screen.queryByRole('button', { name: /use opencode default/i })).toBeNull();
    expect(screen.queryByText(/opencode default/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /enter exact ids manually/i }));
    fireEvent.change(screen.getByLabelText('OpenCode provider ID'), {
      target: { value: 'openai' },
    });
    fireEvent.change(screen.getByLabelText('OpenCode model ID'), {
      target: { value: 'gpt-5' },
    });
    fireEvent.click(screen.getByRole('button', { name: /use exact ids/i }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'openai', model: 'gpt-5' });
  });

  it('accepts an exact provider and model outside the known catalog', async () => {
    const onChange = vi.fn();
    const { client } = clientWithCatalog();
    render(<OpenCodeModelSelector client={client as never} onChange={onChange} />);

    await screen.findByLabelText('OpenCode provider');
    fireEvent.click(screen.getByRole('button', { name: /enter exact ids manually/i }));
    fireEvent.change(screen.getByLabelText('OpenCode provider ID'), {
      target: { value: 'custom-provider' },
    });
    fireEvent.change(screen.getByLabelText('OpenCode model ID'), {
      target: { value: 'custom-model' },
    });
    fireEvent.click(screen.getByRole('button', { name: /use exact ids/i }));

    expect(onChange).toHaveBeenLastCalledWith({
      provider: 'custom-provider',
      model: 'custom-model',
    });
  });

  it('refreshes explicitly and preserves an unavailable stored pair visibly', async () => {
    const onChange = vi.fn();
    const { client, find } = clientWithCatalog();
    render(
      <OpenCodeModelSelector
        value={{ provider: 'legacy', model: 'removed' }}
        client={client as never}
        onChange={onChange}
      />
    );

    expect(
      await screen.findByText(/legacy\/removed is outside the known model catalog/i)
    ).toBeTruthy();
    expect(screen.getByDisplayValue('legacy')).toBeTruthy();
    expect(screen.getByDisplayValue('removed')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /refresh known models/i }));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not request a catalog for a foreign-owned collaborative session', () => {
    const { client, find } = clientWithCatalog();
    render(
      <OpenCodeModelSelector
        value={{ provider: 'openai', model: 'gpt-5' }}
        client={client as never}
        catalogEnabled={false}
      />
    );

    expect(find).not.toHaveBeenCalled();
    expect(
      screen.getByText(/execution uses the immutable session owner's opencode credentials/i)
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /use opencode default/i })).toBeNull();
    expect(screen.getByLabelText('OpenCode provider ID')).toBeTruthy();
  });

  it('does not render a prior user catalog during a client-switch commit', async () => {
    const first = clientWithCatalog();
    const secondFind = vi.fn().mockRejectedValue(new Error('next user unavailable'));
    const second = {
      find: secondFind,
      client: { service: vi.fn(() => ({ find: secondFind })) },
    };
    const staleCatalogSeenDuringCommit: boolean[] = [];

    const Harness = () => {
      const [client, setClient] = useState(first.client);
      useLayoutEffect(() => {
        if (client === second.client) {
          staleCatalogSeenDuringCommit.push(
            document.body.querySelector('[aria-label="OpenCode provider"]') !== null
          );
        }
      }, [client]);
      return (
        <>
          <button type="button" onClick={() => setClient(second.client)}>
            Switch user
          </button>
          <OpenCodeModelSelector client={client as never} />
        </>
      );
    };

    render(<Harness />);
    expect(await screen.findByLabelText('OpenCode provider')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /switch user/i }));

    expect(staleCatalogSeenDuringCommit).toEqual([false]);
    expect(await screen.findByText(/could not refresh the known model catalog/i)).toBeTruthy();
    expect(first.find).toHaveBeenCalledTimes(1);
    expect(second.find).toHaveBeenCalledTimes(1);
  });

  it('does not render an owner catalog during the owner-to-foreign commit', async () => {
    const { client } = clientWithCatalog();
    const staleCatalogSeenDuringCommit: boolean[] = [];

    const Harness = () => {
      const [catalogEnabled, setCatalogEnabled] = useState(true);
      useLayoutEffect(() => {
        if (!catalogEnabled) {
          staleCatalogSeenDuringCommit.push(
            document.body.querySelector('[aria-label="OpenCode provider"]') !== null
          );
        }
      }, [catalogEnabled]);
      return (
        <>
          <button type="button" onClick={() => setCatalogEnabled(false)}>
            View foreign session
          </button>
          <OpenCodeModelSelector
            client={client as never}
            branchId="branch-a"
            catalogEnabled={catalogEnabled}
          />
        </>
      );
    };

    render(<Harness />);
    expect(await screen.findByLabelText('OpenCode provider')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /view foreign session/i }));

    expect(staleCatalogSeenDuringCommit).toEqual([false]);
    expect(
      screen.getByText(/execution uses the immutable session owner's opencode credentials/i)
    ).toBeTruthy();
  });
});
