// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeModelSelector } from './OpenCodeModelSelector.js';
import { invalidateOpenCodeModelCatalog } from './useOpenCodeModelCatalog.js';

const catalog = {
  runtimeVersion: '1.14.33',
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      availableForSelection: true,
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
    availableForSelection: true,
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
    const onCommit = vi.fn();
    const { client, find } = clientWithCatalog();
    render(
      <OpenCodeModelSelector
        client={client as never}
        branchId="branch-1"
        onChange={onChange}
        onCommit={onCommit}
      />
    );

    const providerSelect = await screen.findByLabelText('OpenCode provider');
    await waitFor(() => expect(find).toHaveBeenCalledWith());

    fireEvent.mouseDown(providerSelect);
    fireEvent.click(await screen.findByText('OpenAI'));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByLabelText('OpenCode model'));
    fireEvent.click(await screen.findByText('GPT-5'));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'openai', model: 'gpt-5' });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenLastCalledWith({ provider: 'openai', model: 'gpt-5' });
  });

  it('keeps immediate catalog entries unselectable until availability resolves', async () => {
    const pending = deferred<typeof catalog>();
    const { client } = clientWithCatalog(pending.promise);
    render(<OpenCodeModelSelector client={client as never} />);

    const providerSelect = screen.getByLabelText('OpenCode provider');
    fireEvent.mouseDown(providerSelect);
    expect(screen.queryByText('OpenAI')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enter exact ids manually/i })).toBeInTheDocument();

    await act(async () => pending.resolve(catalog));
    fireEvent.mouseDown(providerSelect);
    expect(await screen.findByText('OpenAI')).toBeInTheDocument();
  });

  it('applies a safe catalog suggestion only while the selection is empty', async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { client } = clientWithCatalog({
      ...catalog,
      suggestedSelection: { providerId: 'openai', modelId: 'gpt-5' },
    });
    const { rerender } = render(
      <OpenCodeModelSelector client={client as never} onChange={onChange} onCommit={onCommit} />
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' })
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    rerender(
      <OpenCodeModelSelector
        value={{ provider: 'manual', model: 'stored' }}
        client={client as never}
        onChange={onChange}
        onCommit={onCommit}
      />
    );
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('omits unavailable providers and their models from normal selection', async () => {
    const onChange = vi.fn();
    const { client } = clientWithCatalog({
      ...catalog,
      providers: [
        ...catalog.providers,
        {
          id: 'catalog-only',
          name: 'Catalog only',
          availableForSelection: false,
          models: [{ id: 'manual-model', name: 'Manual model', status: 'active' }],
        },
      ],
    });
    render(<OpenCodeModelSelector client={client as never} onChange={onChange} />);

    const providerSelect = await screen.findByLabelText('OpenCode provider');
    await waitFor(() => expect(client.service).toHaveBeenCalled());
    fireEvent.mouseDown(providerSelect);
    expect(screen.queryByText(/catalog only/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/manual model/i)).not.toBeInTheDocument();

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('OpenCode model')).toBeDisabled();
    expect(screen.getByRole('button', { name: /enter exact ids manually/i })).toBeInTheDocument();
  });

  it('keeps a 320-model compact catalog bounded and emits one searched exact pair', async () => {
    const onChange = vi.fn();
    const { client } = clientWithCatalog(nativeScaleCatalog);
    render(<OpenCodeModelSelector client={client as never} onChange={onChange} compact />);

    const selector = await screen.findByLabelText('OpenCode model');
    await waitFor(() => expect(client.service).toHaveBeenCalled());
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
        availableForSelection: false,
      })),
    });

    render(
      <OpenCodeModelSelector
        value={{ provider: 'openai', model: 'gpt-5' }}
        client={client as never}
        compact
      />
    );

    expect(await screen.findByText('openai/gpt-5 (unavailable)')).toBeInTheDocument();
    expect(screen.getByLabelText('OpenCode model warning')).toBeInTheDocument();
  });

  it('does not open exact entry while saved-provider evidence is still loading', async () => {
    const resolvedCatalog = {
      ...catalog,
      providers: catalog.providers.map((provider) => ({
        ...provider,
        models: [
          ...provider.models,
          { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', status: 'active' as const },
        ],
      })),
    };
    const pending = deferred<typeof resolvedCatalog>();
    const client = { service: vi.fn(() => ({ find: vi.fn(() => pending.promise) })) };

    render(
      <OpenCodeModelSelector
        client={client as never}
        value={{ provider: 'openai', model: 'gpt-5.6-luna' }}
      />
    );

    expect(screen.queryByLabelText('OpenCode provider ID')).not.toBeInTheDocument();
    await act(async () => pending.resolve(resolvedCatalog));
    expect(await screen.findByText('OpenAI')).toBeInTheDocument();
    expect(screen.queryByLabelText('OpenCode provider ID')).not.toBeInTheDocument();
  });

  it('keeps manual exact entry available without an automatic default when refresh fails', async () => {
    const onChange = vi.fn();
    const find = vi.fn().mockRejectedValue(new Error('private path /secret should not render'));
    const client = { service: vi.fn(() => ({ find })) };
    render(<OpenCodeModelSelector client={client as never} onChange={onChange} />);

    expect(await screen.findByText(/could not load configured opencode providers/i)).toBeTruthy();
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

  it('shows a configured custom provider and opens exact model entry for it', async () => {
    const { client } = clientWithCatalog({
      ...catalog,
      providers: [
        ...catalog.providers,
        {
          id: 'custom-provider',
          name: 'custom-provider',
          availableForSelection: true,
          models: [],
        },
      ],
    });
    render(<OpenCodeModelSelector client={client as never} />);

    const providerSelect = await screen.findByLabelText('OpenCode provider');
    fireEvent.mouseDown(providerSelect);
    fireEvent.click(await screen.findByTitle('custom-provider'));

    expect(screen.getByLabelText('OpenCode model')).toBeDisabled();
    expect(screen.getByLabelText('OpenCode provider ID')).toHaveValue('custom-provider');
    expect(screen.getByText('Enter an exact model ID below')).toBeInTheDocument();
  });

  it('shares configured-provider reads and invalidates after mutations and reauthentication', async () => {
    const find = vi.fn().mockResolvedValue(catalog);
    let authentication: unknown = { userId: 'first' };
    let authenticated: (() => void) | undefined;
    const client = {
      service: vi.fn(() => ({ find })),
      get: vi.fn(() => authentication),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'authenticated') authenticated = listener;
      }),
    };
    render(
      <>
        <OpenCodeModelSelector client={client as never} />
        <OpenCodeModelSelector client={client as never} compact />
      </>
    );

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    act(() => invalidateOpenCodeModelCatalog(client as never));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    authentication = { userId: 'second' };
    act(() => authenticated?.());
    await waitFor(() => expect(find).toHaveBeenCalledTimes(3));
  });

  it('has no unconditional refresh control and preserves an unavailable stored pair visibly', async () => {
    const onChange = vi.fn();
    const { client } = clientWithCatalog();
    render(
      <OpenCodeModelSelector
        value={{ provider: 'legacy', model: 'removed' }}
        client={client as never}
        onChange={onChange}
      />
    );

    expect(await screen.findByText(/legacy\/removed is outside the known catalog/i)).toBeTruthy();
    expect(screen.getByDisplayValue('legacy')).toBeTruthy();
    expect(screen.getByDisplayValue('removed')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    expect(screen.queryByRole('button', { name: /refresh known models/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull();
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
    const Harness = () => {
      const [client, setClient] = useState(first.client);
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
    const providerSelect = await screen.findByLabelText('OpenCode provider');
    await waitFor(() => expect(first.find).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(providerSelect);
    expect(await screen.findByText('OpenAI')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: /switch user/i }));

    expect(await screen.findByText(/could not load configured opencode providers/i)).toBeTruthy();
    expect(screen.queryByText('OpenAI')).toBeNull();
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
