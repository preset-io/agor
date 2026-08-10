import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { AgenticToolConfigForm } from './AgenticToolConfigForm';

vi.mock('../ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
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
});
