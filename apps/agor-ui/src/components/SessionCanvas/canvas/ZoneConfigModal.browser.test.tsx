import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, Card } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { ZoneConfigModal } from './ZoneConfigModal';

vi.mock('../../../contexts/ConnectionContext', () => ({
  useMutationGate: () => ({ canMutate: true }),
}));

vi.mock('../../AgentSelectionGrid', () => ({
  AVAILABLE_AGENTS: [],
  // Like the real agent cards, this custom control does not consume Form.disabled.
  AgentSelectionGrid: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => onSelect('codex')}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSelect('codex');
      }}
    >
      Codex
    </Card>
  ),
}));

afterEach(cleanup);

it('makes custom controls inert during persistence and restores interaction on failure', async () => {
  let finish!: (saved: boolean) => void;
  const onUpdate = vi.fn().mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    })
  );
  const onCancel = vi.fn();
  render(
    <AntdApp>
      <ZoneConfigModal
        open
        onCancel={onCancel}
        onUpdate={onUpdate}
        objectId="zone-1"
        zoneName="Review"
        zoneData={{
          type: 'zone',
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          label: 'Review',
          trigger: { behavior: 'always_new', template: 'Review this branch', agent: 'claude-code' },
        }}
      />
    </AntdApp>
  );
  const agent = await screen.findByRole('button', { name: 'Codex' });
  agent.focus();
  expect(agent).toHaveFocus();
  fireEvent.change(screen.getByLabelText('Prompt template'), {
    target: { value: 'Updated prompt' },
  });
  const save = screen.getByRole('button', { name: 'Save' });
  fireEvent.click(save);
  await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
  // Browser focus behavior, not jsdom's attribute-only approximation of inert.
  await waitFor(() => expect(agent).not.toHaveFocus());
  agent.focus();
  expect(agent).not.toHaveFocus();
  expect(screen.getByLabelText('Prompt template')).toBeDisabled();
  expect(save).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await act(async () => {
    finish(false);
  });
  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Prompt template')).toHaveValue('Updated prompt');
  agent.focus();
  expect(agent).toHaveFocus();
  expect(save).toBeEnabled();
});
