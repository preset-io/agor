import { act, render, screen } from '@testing-library/react';
import { OnboardingSetupTips } from './OnboardingSetupTips';

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('../../hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => motion.reduced,
}));

const currentTip = () => document.querySelector('.slick-current')?.textContent;
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('OnboardingSetupTips', () => {
  it('rotates every 6s and holds still while a dot has keyboard focus', () => {
    motion.reduced = false;
    render(<OnboardingSetupTips teammateName="Ada" />);
    expect(
      screen.getByText('Schedule Ada to send a morning summary or check on things every day.')
    ).toBeInTheDocument();

    const first = currentTip();
    wait(7000);
    const second = currentTip();
    expect(second).not.toBe(first);

    const dot = screen.getAllByRole('button')[0];
    act(() => dot.focus());
    wait(20000);
    expect(currentTip()).toBe(second);

    act(() => dot.blur());
    wait(7000);
    expect(currentTip()).not.toBe(second);
  });

  it('does not rotate under reduced motion', () => {
    motion.reduced = true;
    render(<OnboardingSetupTips />);
    expect(
      screen.getByText('Share your board so everyone can work with your teammate.')
    ).toBeInTheDocument();
    const first = currentTip();
    wait(20000);
    expect(currentTip()).toBe(first);
  });
});
