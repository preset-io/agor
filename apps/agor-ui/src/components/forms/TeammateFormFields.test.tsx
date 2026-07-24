import type { Repo } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { TeammateFormFields } from './TeammateFormFields';

function Harness({ currentBoardId }: { currentBoardId?: string }) {
  const [form] = Form.useForm();
  return (
    <Form form={form} layout="vertical">
      <TeammateFormFields
        form={form}
        repos={[] as Repo[]}
        frameworkRepo={undefined}
        onDisplayNameChange={vi.fn()}
        customRepoSelected={false}
        onCustomRepoChange={vi.fn()}
        currentBoardId={currentBoardId}
      />
    </Form>
  );
}

describe('TeammateFormFields board placement', () => {
  it('shows the new-board checkbox checked by default when a current board exists', () => {
    render(<Harness currentBoardId="board-1" />);

    const checkbox = screen.getByRole('checkbox', {
      name: /create a new board for this teammate/i,
    });
    expect(checkbox).toBeChecked();
  });

  it('hides the checkbox and always uses an own board when there is no current board', () => {
    render(<Harness currentBoardId={undefined} />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/gets its own fresh board/i)).toBeInTheDocument();
  });
});
