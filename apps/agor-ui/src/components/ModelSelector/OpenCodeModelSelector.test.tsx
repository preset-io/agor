import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeModelSelector } from './OpenCodeModelSelector';

describe('OpenCodeModelSelector', () => {
  it('accepts an exact provider/model pair without daemon discovery', () => {
    const onChange = vi.fn();
    render(<OpenCodeModelSelector onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('OpenCode provider ID'), {
      target: { value: 'openai' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ provider: '', model: '' });

    fireEvent.change(screen.getByLabelText('OpenCode model ID'), {
      target: { value: 'gpt-5' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'openai', model: 'gpt-5' });
  });

  it('omits a previously configured override as soon as the pair becomes partial', () => {
    const onChange = vi.fn();
    render(
      <OpenCodeModelSelector value={{ provider: 'openai', model: 'gpt-5' }} onChange={onChange} />
    );

    fireEvent.change(screen.getByLabelText('OpenCode provider ID'), {
      target: { value: '' },
    });

    expect(onChange).toHaveBeenLastCalledWith({ provider: '', model: '' });
  });
});
