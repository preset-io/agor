import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AgenticToolConfigForm } from './AgenticToolConfigForm';

vi.mock('../ModelSelector', () => ({
  ModelSelector: ({
    value,
    onChange,
    onCommit,
    onReasoningEffortLevelsChange,
  }: {
    value?: { provider?: string; model?: string };
    onChange?: (value: { mode: 'exact'; provider: string; model: string }) => void;
    onCommit?: (value: { mode: 'exact'; provider: string; model: string }) => void;
    onReasoningEffortLevelsChange?: (availability: {
      provider: string;
      model: string;
      levels: readonly string[] | undefined;
    }) => void;
  }) => {
    useEffect(() => {
      if (!value?.provider || !value.model) return;
      onReasoningEffortLevelsChange?.({
        provider: value.provider,
        model: value.model,
        levels: value.model === 'qwen3.8-flash' ? [] : ['low', 'medium', 'high'],
      });
    }, [onReasoningEffortLevelsChange, value?.model, value?.provider]);
    const selectQwen = () => {
      const next = {
        mode: 'exact' as const,
        provider: 'opencode-go',
        model: 'qwen3.8-flash',
      };
      onChange?.(next);
      onCommit?.(next);
    };
    return (
      <div data-testid="model-selector">
        <button type="button" onClick={selectQwen}>
          Select Qwen
        </button>
      </div>
    );
  },
}));
vi.mock('../PermissionModeSelector', () => ({
  CODEX_APPROVAL_POLICIES: [],
  CODEX_SANDBOX_MODES: [],
  PermissionModeSelector: () => <div data-testid="permission-selector" />,
}));
vi.mock('../CodexNetworkAccessToggle', () => ({
  CodexNetworkAccessToggle: () => <div data-testid="network-toggle" />,
}));
vi.mock('../EffortSelector', () => ({
  EffortSelector: ({
    levels,
    allowInherited,
  }: {
    levels?: readonly string[];
    allowInherited?: boolean;
  }) => (
    <div data-testid="effort-selector">
      {levels?.join(',')}|{allowInherited ? 'inherited' : 'fixed'}
    </div>
  ),
}));

function renderForm(agenticTool: 'codex' | 'gemini' | 'opencode') {
  render(
    <Form>
      <AgenticToolConfigForm agenticTool={agenticTool} />
    </Form>
  );
}

describe('AgenticToolConfigForm reasoning effort', () => {
  it.each(['codex', 'opencode'] as const)(
    'renders the exact five effort levels for %s with inherited runtime configuration',
    (agenticTool) => {
      renderForm(agenticTool);
      expect(screen.getByTestId('effort-selector').textContent).toBe(
        'low,medium,high,xhigh,max|inherited'
      );
    }
  );

  it('omits the control for unsupported tools', () => {
    renderForm('gemini');
    expect(screen.queryByTestId('effort-selector')).not.toBeInTheDocument();
  });

  it('fails form validation for an incomplete OpenCode pair', async () => {
    const onFinish = vi.fn();
    render(
      <Form
        initialValues={{ modelConfig: { mode: 'exact', model: 'gpt-test' } }}
        onFinish={onFinish}
      >
        <AgenticToolConfigForm agenticTool="opencode" />
        <button type="submit">Save</button>
      </Form>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/exact OpenCode provider and model/i)).toBeInTheDocument();
    await waitFor(() => expect(onFinish).not.toHaveBeenCalled());
  });

  it('shows inherited only and rejects a stored effort for a known-empty OpenCode model', async () => {
    const onFinish = vi.fn();
    render(
      <Form
        initialValues={{
          modelConfig: { mode: 'exact', provider: 'opencode-go', model: 'qwen3.8-flash' },
          effort: 'high',
        }}
        onFinish={onFinish}
      >
        <AgenticToolConfigForm agenticTool="opencode" />
        <button type="submit">Save</button>
      </Form>
    );

    await waitFor(() =>
      expect(screen.getByTestId('effort-selector').textContent).toBe('|inherited')
    );
    expect(screen.getByText(/no explicit effort.*use inherited/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onFinish).not.toHaveBeenCalled());
  });

  it('clears an incompatible stale effort after an explicit model change', async () => {
    const onFinish = vi.fn();
    render(
      <Form
        initialValues={{
          modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-test' },
          effort: 'high',
        }}
        onFinish={onFinish}
      >
        <AgenticToolConfigForm agenticTool="opencode" />
        <button type="submit">Save</button>
      </Form>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Select Qwen' }));
    await waitFor(() =>
      expect(screen.getByTestId('effort-selector').textContent).toBe('|inherited')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({
          modelConfig: expect.objectContaining({ model: 'qwen3.8-flash' }),
          effort: undefined,
        })
      )
    );
  });
});
