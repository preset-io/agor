import type { AgorClient, Branch } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Button, Form } from 'antd';
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

function Harness({ client, onFinish = vi.fn() }: { client: AgorClient; onFinish?: () => void }) {
  const [form] = Form.useForm();
  return (
    <Form form={form} layout="vertical" onFinish={onFinish} aria-label="Gateway target">
      <GatewayTargetFields client={client} />
      <Button htmlType="submit">Continue</Button>
      <Button onClick={() => form.resetFields()}>Reset</Button>
    </Form>
  );
}

async function select(label: string, option: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByTitle(option));
}

describe('GatewayTargetFields', () => {
  withTestAuthority();

  it('defaults to a required, labelled teammate picker and submits the existing branch ID', async () => {
    const { client, find } = makeClient();
    const onFinish = vi.fn();
    render(<Harness client={client} onFinish={onFinish} />);
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
    expect(screen.queryByTitle('Long-lived branch')).not.toBeInTheDocument();
    expect(screen.queryByTitle('AI Archived (Archived (archived))')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith({
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
    fireEvent.click(screen.getByText('Reset'));
    expect(screen.getByRole('radio', { name: 'AI Teammate' })).toBeChecked();
  });

  it('distinguishes duplicate teammate display names and submits the chosen branch', async () => {
    const support = { ...ada, branch_id: ordinary.branch_id, name: 'support-teammate' };
    const onFinish = vi.fn();
    render(<Harness client={makeClient([ada, support]).client} onFinish={onFinish} />);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'AI Teammate' }));
    expect(await screen.findByTitle('AI Ada (Ada)')).toBeInTheDocument();
    fireEvent.click(await screen.findByTitle('AI Ada (support-teammate)'));
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith({
        target_kind: 'teammate',
        target_branch_id: ordinary.branch_id,
      })
    );
    expect(
      within(screen.getByRole('form', { name: 'Gateway target' })).getByText(
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
    fireEvent.keyDown(picker, { key: 'Enter', keyCode: 13 });
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith({
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
