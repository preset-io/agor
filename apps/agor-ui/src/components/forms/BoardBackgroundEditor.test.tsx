// biome-ignore-all lint/plugin/noHardcodedColorLiteral: test fixtures assert on literal CSS background values
import { GOLD_SHIMMER_BOARD_BACKGROUND } from '@agor/core/design/board-backgrounds';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Form, type FormInstance } from 'antd';
import { describe, expect, it } from 'vitest';
import { BoardBackgroundEditor, deriveBackgroundMode } from './BoardBackgroundEditor';
import { BACKGROUND_PRESETS } from './boardBackgroundPresets';

const CUSTOM_GRADIENT = 'linear-gradient(180deg, #101010, #202020)';
const PRESET = BACKGROUND_PRESETS[0];

let captured: FormInstance | null = null;

function Harness({
  signal,
  initialValues,
}: {
  signal?: string;
  initialValues?: Record<string, unknown>;
}) {
  const [form] = Form.useForm();
  captured = form;
  return (
    <Form form={form} initialValues={initialValues} preserve>
      <BoardBackgroundEditor form={form} resetSignal={signal} />
    </Form>
  );
}

const DEFAULT_TEXT = /Uses the built-in theme-aware background/i;

describe('deriveBackgroundMode', () => {
  it('returns default only when nothing is styled', () => {
    expect(deriveBackgroundMode(undefined, undefined)).toBe('default');
  });

  it('returns preset when the background exactly matches a gallery preset', () => {
    expect(deriveBackgroundMode(PRESET.value, undefined)).toBe('preset');
    // Gold Shimmer is a gallery preset, so a board carrying it opens in Preset
    // mode (it is NOT swallowed as a legacy "default").
    expect(deriveBackgroundMode(GOLD_SHIMMER_BOARD_BACKGROUND, undefined)).toBe('preset');
  });

  it('returns custom for arbitrary CSS or any custom_css', () => {
    expect(deriveBackgroundMode(CUSTOM_GRADIENT, undefined)).toBe('custom');
    expect(deriveBackgroundMode(PRESET.value, 'animation: x 1s;')).toBe('custom');
  });
});

describe('BoardBackgroundEditor', () => {
  it('opens in Default mode with an empty board', () => {
    render(<Harness signal="a" initialValues={{}} />);
    expect(screen.getByText(DEFAULT_TEXT)).toBeInTheDocument();
  });

  it('opens in Custom mode and shows the saved CSS when a board has custom styling', () => {
    render(<Harness signal="a" initialValues={{ background_color: CUSTOM_GRADIENT }} />);
    const textarea = screen.getByLabelText('Custom background CSS') as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toBe(CUSTOM_GRADIENT);
  });

  it('opens in Preset mode with the matching thumbnail selected', () => {
    render(<Harness signal="a" initialValues={{ background_color: PRESET.value }} />);
    const selected = screen.getByRole('button', {
      name: new RegExp(`${PRESET.label}`, 'i'),
      pressed: true,
    });
    expect(selected).toBeInTheDocument();
  });

  it('switching to Default clears the stored background and custom CSS', () => {
    render(<Harness signal="a" initialValues={{ background_color: CUSTOM_GRADIENT }} />);
    fireEvent.click(screen.getByText('Default'));
    expect(screen.getByText(DEFAULT_TEXT)).toBeInTheDocument();
    expect(captured?.getFieldValue('background_color')).toBeFalsy();
    expect(captured?.getFieldValue('custom_css')).toBeFalsy();
  });

  it('selecting a preset writes its exact CSS value to the form', () => {
    render(<Harness signal="a" initialValues={{}} />);
    fireEvent.click(screen.getByText('Preset'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(PRESET.label, 'i') }));
    expect(captured?.getFieldValue('background_color')).toBe(PRESET.value);
  });

  it('re-syncs its mode from freshly loaded values when the reset signal changes (reopen)', () => {
    // Reproduces the reopen bug: the editor first mounts against empty values
    // (async board load not yet resolved), then the board's saved custom CSS
    // arrives and the reset signal bumps — the mode must follow the new values.
    const { rerender } = render(<Harness signal="a" initialValues={{}} />);
    expect(screen.getByText(DEFAULT_TEXT)).toBeInTheDocument();

    act(() => {
      captured?.setFieldsValue({ background_color: CUSTOM_GRADIENT });
    });
    rerender(<Harness signal="b" initialValues={{}} />);

    const textarea = screen.getByLabelText('Custom background CSS') as HTMLTextAreaElement;
    expect(textarea.value).toBe(CUSTOM_GRADIENT);
    expect(screen.queryByText(DEFAULT_TEXT)).not.toBeInTheDocument();
  });
});
