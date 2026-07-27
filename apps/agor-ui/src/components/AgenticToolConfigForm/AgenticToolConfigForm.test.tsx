import { render, screen } from '@testing-library/react';
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

function renderForm(agenticTool: 'codex' | 'gemini') {
  render(
    <Form>
      <AgenticToolConfigForm agenticTool={agenticTool} />
    </Form>
  );
}

describe('AgenticToolConfigForm reasoning effort', () => {
  it('renders truthful Codex levels with inherited runtime configuration', () => {
    renderForm('codex');
    expect(screen.getByTestId('effort-selector')).toHaveTextContent(
      'low,medium,high,xhigh|inherited'
    );
  });

  it('omits the control for unsupported tools', () => {
    renderForm('gemini');
    expect(screen.queryByTestId('effort-selector')).not.toBeInTheDocument();
  });
});
