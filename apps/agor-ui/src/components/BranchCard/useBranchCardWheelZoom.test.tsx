import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { REACT_FLOW_NO_WHEEL_CLASS } from '../../utils/reactFlowDragClasses';
import { useBranchCardWheelZoom } from './useBranchCardWheelZoom';

function Card({ enabled = true }: { enabled?: boolean }) {
  const ref = useBranchCardWheelZoom(enabled);
  return (
    <div ref={ref}>
      <div className={REACT_FLOW_NO_WHEEL_CLASS}>
        <button type="button">Row</button>
      </div>
      <button type="button">Header</button>
    </div>
  );
}

afterEach(cleanup);

it.each([{ ctrlKey: true }, { metaKey: true }])(
  'forwards %o before native inner scrolling, preserving the wheel payload',
  (modifier) => {
    const { container } = render(
      <div className="react-flow__renderer">
        <Card />
      </div>
    );
    const renderer = container.firstElementChild!;
    const row = screen.getByText('Row');
    const innerWheel = vi.fn();
    row.addEventListener('wheel', innerWheel);
    const routed: WheelEvent[] = [];
    renderer.addEventListener('wheel', (event) => routed.push(event as WheelEvent));
    const payload = {
      bubbles: true,
      cancelable: true,
      deltaX: 3,
      deltaY: -2,
      deltaZ: 1,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      clientX: 140,
      clientY: 220,
      shiftKey: true,
      ...modifier,
    };
    const event = new WheelEvent('wheel', payload);
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(innerWheel).not.toHaveBeenCalled();
    expect(routed).toHaveLength(1);
    expect(routed[0]).not.toBe(event);
    expect(routed[0]).toMatchObject(payload);
    expect(routed[0].target).toBe(renderer);
  }
);

it('leaves ordinary/Shift/Alt wheel and unmarked card surfaces alone', () => {
  render(
    <div className="react-flow__renderer">
      <Card />
    </div>
  );
  for (const modifier of [{}, { shiftKey: true }, { altKey: true }]) {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...modifier });
    const listener = vi.fn();
    screen.getByText('Row').addEventListener('wheel', listener, { once: true });
    screen.getByText('Row').dispatchEvent(event);
    expect(listener).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
  }
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true });
  screen.getByText('Header').dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});

it('does not suppress standalone/panel/popover zoom and removes the listener when disabled or unmounted', () => {
  const { rerender, unmount } = render(<Card />);
  const dispatch = (row = screen.getByText('Row')) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true });
    row.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(dispatch()).toBe(false);
  rerender(
    <div className="react-flow__renderer">
      <Card />
    </div>
  );
  expect(dispatch()).toBe(true);
  rerender(
    <div className="react-flow__renderer">
      <Card enabled={false} />
    </div>
  );
  expect(dispatch()).toBe(false);
  rerender(
    <div className="react-flow__renderer">
      <Card />
    </div>
  );
  expect(dispatch()).toBe(true);
  const row = screen.getByText('Row');
  unmount();
  expect(dispatch(row)).toBe(false);
});
