import { render, screen } from '@testing-library/react';
import type { CarouselProps } from 'antd';
import { OnboardingSetupTips } from './OnboardingSetupTips';

const motion = vi.hoisted(() => ({ reduced: false, props: null as CarouselProps | null }));
vi.mock('../../hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => motion.reduced,
}));
vi.mock('antd', async (importOriginal) => {
  const antd = await importOriginal<typeof import('antd')>();
  return {
    ...antd,
    Carousel: (props: CarouselProps) => {
      motion.props = props;
      return <div>{props.children}</div>;
    },
  };
});

describe('OnboardingSetupTips', () => {
  it('rotates every 6s with dots, pausing on hover and focus', () => {
    motion.reduced = false;
    render(<OnboardingSetupTips teammateName="Ada" />);
    expect(motion.props).toMatchObject({
      autoplay: true,
      autoplaySpeed: 6000,
      effect: 'fade',
      pauseOnHover: true,
      pauseOnFocus: true,
    });
    expect(motion.props?.dots).not.toBe(false);
    expect(
      screen.getByText('Schedule Ada to send a morning summary or check on things every day.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ada saves notes and decisions to Knowledge and picks up where you left off.'
      )
    ).toBeInTheDocument();
  });

  it('does not autoplay or animate under reduced motion', () => {
    motion.reduced = true;
    render(<OnboardingSetupTips />);
    expect(motion.props).toMatchObject({ autoplay: false, speed: 0 });
    expect(
      screen.getByText('Share your board so everyone can work with your teammate.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your teammate saves notes and decisions to Knowledge and picks up where you left off.'
      )
    ).toBeInTheDocument();
  });
});
