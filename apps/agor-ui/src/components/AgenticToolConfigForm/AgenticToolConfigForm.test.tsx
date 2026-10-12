import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { CodexSettingsForm } from '../CodexSettingsForm';
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

describe('Include native Codex plugins', () => {
  it('is off by default, can be enabled, and saves an explicit false', async () => {
    const onFinish = vi.fn();
    render(
      <Form onFinish={onFinish}>
        <AgenticToolConfigForm agenticTool="codex" />
        <button type="submit">Save</button>
      </Form>
    );
    const toggle = screen.getByRole('switch', { name: 'Include native Codex plugins' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ codexIncludePlugins: true })
      )
    );
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ codexIncludePlugins: false })
      )
    );
  });
  it('does not render for other tools', () => {
    renderForm('gemini');
    expect(
      screen.queryByRole('switch', { name: 'Include native Codex plugins' })
    ).not.toBeInTheDocument();
  });
});

it('restores and saves the session plugin opt-in through the standalone settings form', async () => {
  const onFinish = vi.fn();
  render(
    <Form initialValues={{ codexIncludePlugins: true }} onFinish={onFinish}>
      <CodexSettingsForm />
      <button type="submit">Save</button>
    </Form>
  );
  const toggle = screen.getByRole('switch', { name: 'Include native Codex plugins' });
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ codexIncludePlugins: false }))
  );
});
