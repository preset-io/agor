import { ONBOARDING_ANALYTICS_STEPS, type OnboardingAnalyticsStep } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { type PropsWithChildren, StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trackProductEvent } from '../utils/productAnalytics';
import { useHomeViewAnalytics, useOnboardingViewAnalytics } from './useProductAnalytics';

vi.mock('../utils/productAnalytics', () => ({ trackProductEvent: vi.fn() }));
const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it('records Home only for an authenticated visit, not rerenders/StrictMode; remount is a new visit', () => {
  const view = renderHook(({ userId }: { userId?: string }) => useHomeViewAnalytics(userId), {
    initialProps: {},
    wrapper,
  });
  expect(trackProductEvent).not.toHaveBeenCalled();
  view.rerender({ userId: 'alice' });
  view.rerender({ userId: 'alice' });
  expect(trackProductEvent).toHaveBeenCalledExactlyOnceWith('alice', { event: 'home.viewed' });
  view.unmount();
  renderHook(() => useHomeViewAnalytics('alice'), { wrapper });
  expect(trackProductEvent).toHaveBeenCalledTimes(2);
});

it('starts once, records actual steps and Back visits, and ignores render-only changes', () => {
  const input = { userId: 'alice', open: true, step: 'workspace' as OnboardingAnalyticsStep };
  const view = renderHook(
    (props) => useOnboardingViewAnalytics(props.userId, props.open, props.step),
    { initialProps: input, wrapper }
  );
  act(() => vi.runAllTimers());
  for (const step of ONBOARDING_ANALYTICS_STEPS) {
    view.rerender({ ...input, step });
    act(() => vi.runAllTimers());
  }
  expect(vi.mocked(trackProductEvent).mock.calls.map(([, e]) => e)).toEqual([
    { event: 'onboarding.step', step: 'workspace', action: 'started' },
    ...ONBOARDING_ANALYTICS_STEPS.map((step) => ({
      event: 'onboarding.step',
      step,
      action: 'viewed',
    })),
  ]);
  view.rerender({ ...input, step: 'tools' });
  act(() => vi.runAllTimers());
  expect(trackProductEvent).toHaveBeenLastCalledWith('alice', {
    event: 'onboarding.step',
    step: 'tools',
    action: 'viewed',
  });
});

it('observes the settled resumed step and cancels stale/closed activations', () => {
  const input = { userId: 'alice', open: true, step: 'workspace' as OnboardingAnalyticsStep };
  const view = renderHook(
    (props) => useOnboardingViewAnalytics(props.userId, props.open, props.step),
    { initialProps: input }
  );
  view.rerender({ ...input, step: 'done' });
  act(() => vi.runAllTimers());
  expect(trackProductEvent).toHaveBeenCalledTimes(2);
  expect(trackProductEvent).toHaveBeenCalledWith('alice', {
    event: 'onboarding.step',
    step: 'done',
    action: 'started',
  });
  view.rerender({ ...input, step: 'llm' });
  view.rerender({ ...input, open: false });
  act(() => vi.runAllTimers());
  expect(trackProductEvent).toHaveBeenCalledTimes(2);
  view.rerender({ ...input, userId: 'bob' });
  act(() => vi.runAllTimers());
  expect(trackProductEvent).toHaveBeenCalledWith('bob', {
    event: 'onboarding.step',
    step: 'workspace',
    action: 'started',
  });
});
