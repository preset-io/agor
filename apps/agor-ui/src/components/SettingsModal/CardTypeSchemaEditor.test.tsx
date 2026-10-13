import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CardTypeSchemaEditor } from './CardTypeSchemaEditor';

const json = (schema: unknown) => JSON.stringify(schema, null, 2);

describe('CardTypeSchemaEditor', () => {
  it.each([
    [
      'an enum',
      {
        type: 'object',
        properties: { status: { type: 'string', enum: ['open', 'done'] } },
        required: ['status'],
      },
    ],
    [
      'numeric bounds',
      { type: 'object', properties: { points: { type: 'integer', minimum: 1, maximum: 13 } } },
    ],
    [
      'root additionalProperties: false',
      { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: false },
    ],
  ])('keeps a schema with %s in JSON mode, so nothing is dropped', (_, schema) => {
    const onChange = vi.fn();
    render(<CardTypeSchemaEditor value={json(schema)} onChange={onChange} />);

    // No field list to toggle Required in, and leaving JSON mode is refused.
    expect(screen.queryByRole('checkbox', { name: 'Required' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Required' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('edits a plain schema in the field list and keeps every field on a Required toggle', () => {
    const onChange = vi.fn();
    const schema = {
      type: 'object',
      properties: { status: { type: 'string' }, points: { type: 'integer' } },
      required: ['status'],
    };
    render(<CardTypeSchemaEditor value={json(schema)} onChange={onChange} />);

    const [, pointsRequired] = screen.getAllByRole('checkbox', { name: 'Required' });
    fireEvent.click(pointsRequired);
    expect(JSON.parse(onChange.mock.lastCall?.[0])).toEqual({
      ...schema,
      required: ['status', 'points'],
    });
  });
});
