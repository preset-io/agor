import type { Repo, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form, Input } from 'antd';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TeammateTab, type TeammateTabResult } from './TeammateTab';

vi.mock('../../../hooks/useEnsureFrameworkRepo', () => ({
  useEnsureFrameworkRepo: () => ({
    frameworkRepo: {
      repo_id: 'framework-repo',
      slug: 'preset-io/agor-teammate',
      name: 'agor-teammate',
    } as Repo,
    isCloning: false,
  }),
}));

vi.mock('../../forms/TeammateFormFields', () => ({
  TeammateFormFields: ({
    onDisplayNameChange,
    extraBeforeAdvanced,
  }: {
    onDisplayNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    extraBeforeAdvanced?: React.ReactNode;
  }) => (
    <>
      <Form.Item name="displayName">
        <Input aria-label="Teammate name" onChange={onDisplayNameChange} />
      </Form.Item>
      {extraBeforeAdvanced}
    </>
  ),
}));

vi.mock('../../AgentSelectionGrid', () => ({
  AgentSelectionGrid: ({ onSelect }: { onSelect: (agent: string) => void }) => (
    <button type="button" onClick={() => onSelect('opencode')}>
      OpenCode
    </button>
  ),
}));

vi.mock('../../AgenticToolConfigurationPicker', () => {
  const ModelConfigControl = ({
    value,
    onChange,
  }: {
    value?: { mode: 'exact'; provider?: string; model: string };
    onChange?: (value: { mode: 'exact'; provider?: string; model: string } | undefined) => void;
  }) => (
    <div>
      <output data-testid="teammate-model">
        {value ? `${value.provider ?? ''}/${value.model}` : ''}
      </output>
      <button type="button" onClick={() => onChange?.(undefined)}>
        Clear model
      </button>
      <button
        type="button"
        onClick={() => onChange?.({ mode: 'exact', provider: 'anthropic', model: 'claude-4' })}
      >
        Complete model
      </button>
    </div>
  );

  return {
    INLINE_AGENTIC_CONFIGURATION: '__inline__',
    AgenticToolConfigurationPicker: ({ currentUser }: { currentUser?: User | null }) => (
      <>
        <output data-testid="teammate-execution-owner">{currentUser?.user_id}</output>
        <Form.Item name="agenticToolPresetId">
          <select aria-label="Configuration source">
            <option value="">Inherit</option>
            <option value="__user_default__">My default</option>
            <option value="__inline__">Inline</option>
          </select>
        </Form.Item>
        <Form.Item name="modelConfig">
          <ModelConfigControl />
        </Form.Item>
      </>
    ),
  };
});

const staleOpenCodeDefault = {
  user_id: 'user-1',
  default_agentic_config: {
    opencode: {
      modelConfig: {
        mode: 'exact',
        provider: 'openai',
        model: 'gpt-5',
        effort: 'high',
      },
    },
  },
} as unknown as User;

function renderTab(currentUser?: User) {
  const formRef = createRef<() => Promise<TeammateTabResult | null>>();
  render(
    <TeammateTab
      repoById={new Map()}
      onValidityChange={() => {}}
      formRef={formRef}
      availableAgents={[{ id: 'opencode', name: 'OpenCode', icon: 'O', description: 'OpenCode' }]}
      currentUser={currentUser}
    />
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Teammate name' }), {
    target: { value: 'Review bot' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));
  fireEvent.click(screen.getByRole('button', { name: /^down Session Configuration$/ }));
  return formRef;
}

async function submit(formRef: React.RefObject<() => Promise<TeammateTabResult | null>>) {
  let result: TeammateTabResult | null | undefined;
  await act(async () => {
    result = await formRef.current?.();
  });
  return result;
}

describe('TeammateTab OpenCode first-session configuration', () => {
  it('offers defaults from the teammate session execution owner', () => {
    renderTab(staleOpenCodeDefault);

    expect(screen.getByTestId('teammate-execution-owner')).toHaveTextContent('user-1');
  });

  it('omits an inline clear so the daemon resolves the personal exact pair', async () => {
    const formRef = renderTab(staleOpenCodeDefault);
    await waitFor(() =>
      expect(screen.getByTestId('teammate-model')).toHaveTextContent('openai/gpt-5')
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Configuration source' }), {
      target: { value: '__inline__' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear model' }));

    const result = await submit(formRef);
    expect(result?.modelConfig).toBeUndefined();
    expect(result?.effort).toBeUndefined();
  });

  it('keeps an omitted override omitted so defaults can be inherited', async () => {
    const formRef = renderTab();

    const result = await submit(formRef);
    expect(result?.modelConfig).toBeUndefined();
  });

  it('serializes a reference without the prefilled inline model', async () => {
    const formRef = renderTab(staleOpenCodeDefault);
    await waitFor(() =>
      expect(screen.getByTestId('teammate-model')).toHaveTextContent('openai/gpt-5')
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Configuration source' }), {
      target: { value: '__user_default__' },
    });

    const result = await submit(formRef);
    expect(result?.agenticToolPresetId).toBe('__user_default__');
    expect(result?.modelConfig).toBeUndefined();
    expect(result?.permissionMode).toBeUndefined();
  });

  it('keeps a complete inline provider/model pair exact', async () => {
    const formRef = renderTab(staleOpenCodeDefault);
    await waitFor(() =>
      expect(screen.getByTestId('teammate-model')).toHaveTextContent('openai/gpt-5')
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Configuration source' }), {
      target: { value: '__inline__' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Complete model' }));

    const result = await submit(formRef);
    expect(result?.modelConfig).toEqual({
      mode: 'exact',
      provider: 'anthropic',
      model: 'claude-4',
    });
  });
});
