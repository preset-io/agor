import type { AgorClient, Branch } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Button, Form, type FormProps } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { deferred, withTestAuthority } from '../../test/harness';
import { GatewayTargetFields } from './GatewayTargetFields';

const branch = (id: string, name: string, teammate = false, archived = false) =>
  ({
    branch_id: id,
    name,
    ref: name,
    archived,
    custom_context: teammate ? { teammate: { kind: 'teammate', displayName: `AI ${name}` } } : {},
  }) as unknown as Branch;

const ada = branch('teammate-1', 'Ada', true);
const ordinary = branch('branch-1', 'Long-lived branch');

function makeClient(rows = [ada, ordinary, branch('old', 'Archived', true, true)]) {
  const find = vi.fn(async () => ({ data: rows }));
  const get = vi.fn(async (id: string) => rows.find((row) => row.branch_id === id));
  const client = { service: () => ({ find, get }) } as unknown as AgorClient;
  return { client, find };
}

function Harness({
  client,
  onFinish = vi.fn(),
  channelTypeLabel = 'Slack',
  onFieldsChange,
}: {
  client: AgorClient;
  onFinish?: () => void;
  channelTypeLabel?: string;
  onFieldsChange?: FormProps['onFieldsChange'];
}) {
  const [form] = Form.useForm();
  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={onFinish}
      onFieldsChange={onFieldsChange}
      aria-label="Gateway target"
    >
      <GatewayTargetFields client={client} channelTypeLabel={channelTypeLabel} />
      <Button htmlType="submit">Continue</Button>
      <Button onClick={() => form.resetFields()}>Reset</Button>
    </Form>
  );
}

async function select(label: string, option: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  const item = await screen.findByTitle(option);
  await act(async () => fireEvent.click(item));
}

describe('GatewayTargetFields', () => {
  withTestAuthority();

  it.each(['AI Teammate', 'Specific branch'])(
    'keeps %s selection compact without repeating visible labels or help',
    async (mode) => {
      render(<Harness client={makeClient().client} />);
      fireEvent.click(screen.getByRole('radio', { name: mode }));
      const picker = await screen.findByRole('combobox', {
        name: mode === 'AI Teammate' ? 'AI Teammate' : 'Target Branch',
      });
      expect(picker).toHaveAttribute('aria-required', 'true');
      expect(screen.getAllByText('AI Teammate')).toHaveLength(1);
      expect(screen.queryByText('Target Branch')).not.toBeInTheDocument();
      expect(screen.queryByText(/Recommended: work with an AI Teammate/)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Use a specific branch for a custom workflow/)
      ).not.toBeInTheDocument();
    }
  );

  it('never validates an empty suggested name during target selection or mode changes', async () => {
    const errors: string[] = [];
    render(
      <Harness
        client={makeClient().client}
        onFieldsChange={(fields) => {
          errors.push(...fields.flatMap((field) => field.errors ?? []));
        }}
      />
    );
    await select('AI Teammate', 'AI Ada (Ada)');
    fireEvent.click(screen.getByRole('radio', { name: 'Specific branch' }));
    await screen.findByRole('combobox', { name: 'Target Branch' });
    await select('Target Branch', 'Long-lived branch');
    expect(await screen.findByText('Long-lived branch · Slack')).toBeVisible();
    // Record every validation result, not just the final DOM after the flash has gone.
    expect(errors).toEqual([]);
  });

  it('defaults to a required, labelled teammate picker and submits the existing branch ID', async () => {
    const { client, find } = makeClient();
    const onFinish = vi.fn();
    const nameErrors: string[] = [];
    render(
      <Harness
        client={client}
        onFinish={onFinish}
        onFieldsChange={(fields) => {
          nameErrors.push(
            ...fields
              .filter((field) => field.name.includes('name'))
              .flatMap((field) => field.errors ?? [])
          );
        }}
      />
    );
    expect(screen.getByRole('radio', { name: 'AI Teammate' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'AI Teammate' })).toHaveAttribute(
      'aria-required',
      'true'
    );
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Please select an AI Teammate')).toBeInTheDocument();
    expect(onFinish).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(find).toHaveBeenCalledWith({
        query: { teammate: true, archived: false, $limit: 50, $sort: { name: 1 } },
      })
    );
    await select('AI Teammate', 'AI Ada (Ada)');
    expect(nameErrors).toEqual([]);
    expect(screen.queryByTitle('Long-lived branch')).not.toBeInTheDocument();
    expect(screen.queryByTitle('AI Archived (Archived (archived))')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith({
        name: 'AI Ada · Slack',
        target_kind: 'teammate',
        target_branch_id: 'teammate-1',
      })
    );
  });

  it('clears the target on mode changes, supports arbitrary branches, and resets to teammate mode', async () => {
    const { client, find } = makeClient();
    const onFinish = vi.fn();
    render(<Harness client={client} onFinish={onFinish} />);
    await select('AI Teammate', 'AI Ada (Ada)');
    fireEvent.click(screen.getByRole('radio', { name: 'Specific branch' }));
    await screen.findByRole('combobox', { name: 'Target Branch' });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Please select a target branch')).toBeInTheDocument();
    expect(onFinish).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(find).toHaveBeenLastCalledWith({
        query: { archived: false, $limit: 50, $sort: { name: 1 } },
      })
    );
    await select('Target Branch', 'Long-lived branch');
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith({
        name: 'Long-lived branch · Slack',
        target_kind: 'branch',
        target_branch_id: 'branch-1',
      })
    );
    onFinish.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: 'AI Teammate' }));
    await screen.findByRole('combobox', { name: 'AI Teammate' });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Please select an AI Teammate')).toBeInTheDocument();
    expect(onFinish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Specific branch' }));
    await act(async () => fireEvent.click(screen.getByText('Reset')));
    expect(screen.getByRole('radio', { name: 'AI Teammate' })).toBeChecked();
  });

  it('distinguishes duplicate teammate display names and submits the chosen branch', async () => {
    const support = { ...ada, branch_id: ordinary.branch_id, name: 'support-teammate' };
    const onFinish = vi.fn();
    render(<Harness client={makeClient([ada, support]).client} onFinish={onFinish} />);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'AI Teammate' }));
    expect(await screen.findByTitle('AI Ada (Ada)')).toBeInTheDocument();
    const supportOption = await screen.findByTitle('AI Ada (support-teammate)');
    await act(async () => fireEvent.click(supportOption));
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith({
        name: 'AI Ada · Slack',
        target_kind: 'teammate',
        target_branch_id: ordinary.branch_id,
      })
    );
    expect(
      within(screen.getByRole('form', { name: 'Gateway target' })).getByTitle(
        'AI Ada (support-teammate)'
      )
    ).toBeInTheDocument();
  });

  it('shows loading and supports selecting a teammate with the keyboard', async () => {
    const pending = deferred<{ data: Branch[] }>();
    const { client, find } = makeClient();
    find.mockImplementationOnce(() => pending.promise);
    const onFinish = vi.fn();
    render(<Harness client={client} onFinish={onFinish} />);
    const picker = screen.getByRole('combobox', { name: 'AI Teammate' });
    fireEvent.keyDown(picker, { key: 'ArrowDown', keyCode: 40 });
    expect(await screen.findByText('Loading AI Teammates…')).toBeInTheDocument();
    await act(async () => pending.resolve({ data: [ada] }));
    await screen.findByTitle('AI Ada (Ada)');
    await act(async () => fireEvent.keyDown(picker, { key: 'Enter', keyCode: 13 }));
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith({
        name: 'AI Ada · Slack',
        target_kind: 'teammate',
        target_branch_id: 'teammate-1',
      })
    );
  });

  it('keeps teammate mode when empty and provides an explicit branch fallback', async () => {
    render(<Harness client={makeClient([]).client} />);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'AI Teammate' }));
    expect(await screen.findByText(/No AI Teammates available/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'AI Teammate' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Specific branch' }));
    expect(await screen.findByRole('combobox', { name: 'Target Branch' })).toBeInTheDocument();
  });

  it('shows the name only after selecting a target and follows target/platform changes', async () => {
    const { client } = makeClient();
    const view = render(<Harness client={client} />);
    expect(screen.getByText('Channel name')).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'Rename gateway' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Channel name' })).not.toBeInTheDocument();
    await select('AI Teammate', 'AI Ada (Ada)');
    expect(await screen.findByText('AI Ada · Slack')).toBeVisible();
    expect(screen.getByText('Channel name')).toBeVisible();
    expect(screen.getByRole('group', { name: 'Channel name' })).toHaveTextContent('AI Ada · Slack');
    expect(screen.getByRole('button', { name: 'Rename gateway' })).toBeVisible();
    view.rerender(<Harness client={client} channelTypeLabel="Discord" />);
    expect(await screen.findByText('AI Ada · Discord')).toBeVisible();
    fireEvent.click(screen.getByRole('radio', { name: 'Specific branch' }));
    await screen.findByRole('combobox', { name: 'Target Branch' });
    expect(screen.queryByRole('button', { name: 'Rename gateway' })).not.toBeInTheDocument();
    await select('Target Branch', 'Long-lived branch');
    expect(await screen.findByText('Long-lived branch · Discord')).toBeVisible();
  });

  it('preserves a custom name across target/platform changes and resets customization with the draft', async () => {
    const { client } = makeClient();
    const onFinish = vi.fn();
    const view = render(<Harness client={client} onFinish={onFinish} />);
    await select('AI Teammate', 'AI Ada (Ada)');
    fireEvent.click(screen.getByRole('button', { name: 'Rename gateway' }));
    const input = screen.getByRole('textbox', { name: 'Channel name' });
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('AI Ada · Slack');
    fireEvent.change(input, { target: { value: 'Support inbox' } });
    view.rerender(<Harness client={client} onFinish={onFinish} channelTypeLabel="Discord" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Specific branch' }));
    await screen.findByRole('combobox', { name: 'Target Branch' });
    await select('Target Branch', 'Long-lived branch');
    expect(screen.getByRole('textbox', { name: 'Channel name' })).toHaveValue('Support inbox');
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith({
        name: 'Support inbox',
        target_kind: 'branch',
        target_branch_id: 'branch-1',
      })
    );
    await act(async () => fireEvent.click(screen.getByText('Reset')));
    expect(screen.queryByRole('textbox', { name: 'Channel name' })).not.toBeInTheDocument();
    await select('AI Teammate', 'AI Ada (Ada)');
    expect(await screen.findByText('AI Ada · Discord')).toBeVisible();
  });

  it('keeps suggesting until text is actually changed, then validates a blank custom name', async () => {
    const { client } = makeClient();
    const onFinish = vi.fn();
    const view = render(<Harness client={client} onFinish={onFinish} />);
    await select('AI Teammate', 'AI Ada (Ada)');
    fireEvent.click(screen.getByRole('button', { name: 'Rename gateway' }));
    view.rerender(<Harness client={client} onFinish={onFinish} channelTypeLabel="Discord" />);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Channel name' })).toHaveValue('AI Ada · Discord')
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Channel name' }), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Please enter a channel name')).toBeVisible();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('searches teammates on the server without relying on the loaded branch store', async () => {
    const { client, find } = makeClient();
    render(<Harness client={client} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'AI Teammate' }), {
      target: { value: 'Ada' },
    });
    await waitFor(() =>
      expect(find).toHaveBeenLastCalledWith({
        query: { teammate: true, archived: false, search: 'ada', $limit: 50, $sort: { name: 1 } },
      })
    );
  });

  it('discards a late teammate response from another tenant authority', async () => {
    const old = deferred<{ data: Branch[] }>();
    const { client, find } = makeClient([]);
    find.mockImplementationOnce(() => old.promise);
    render(<Harness client={client} />);
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    act(() => {
      setRealtimeAuthorityScope('tenant-b-user:admin:2');
      agorStore.getState().setDataAuthority('tenant-b-user:admin:2');
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await act(async () => old.resolve({ data: [ada] }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'AI Teammate' }));
    expect(await screen.findByText(/No AI Teammates available/)).toBeInTheDocument();
    expect(screen.queryByText('AI Ada (Ada)')).not.toBeInTheDocument();
  });
});
