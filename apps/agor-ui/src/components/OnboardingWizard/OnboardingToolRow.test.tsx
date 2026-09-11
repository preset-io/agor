import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ONBOARDING_INTEGRATION_RECOMMENDATIONS as recommendations } from '../../utils/onboardingGoals';
import { useCatalogReadiness } from '../Marketplace/useCatalogReadiness';
import { OnboardingToolRow } from './OnboardingToolRow';

vi.mock('../Marketplace/useCatalogReadiness', () => ({ useCatalogReadiness: vi.fn() }));
afterEach(cleanup);

describe('onboarding auth status presentation', () => {
  it.each([
    ['bearer_required', 'Token required'],
    ['oauth_required', 'Sign in required'],
  ] as const)(
    'uses the neutral inline info Tag for %s without authorizing a connection',
    (state, label) => {
      vi.mocked(useCatalogReadiness).mockReturnValue({
        readiness: { catalog_key: 'github', state },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });
      const onOpen = vi.fn();
      render(
        <OnboardingToolRow
          recommendation={recommendations.github}
          client={null}
          connected
          authGeneration={1}
          userId="alice"
          selected
          onToggle={vi.fn()}
          onOpen={onOpen}
        />
      );
      const status = screen.getByText(label);
      expect(status).toHaveClass('ant-tag', 'ant-tag-default');
      expect(status).not.toHaveAttribute('tabindex');
      expect(status.parentElement).toBe(
        screen.getByText('GitHub').closest('.ant-typography')!.parentElement
      );
      const action = screen.getByRole('button', { name: 'Sign in through Catalog for GitHub' });
      expect(action).toHaveAccessibleDescription(new RegExp(label));
      expect(action).toHaveStyle({ paddingLeft: '0px', fontSize: '12px', minHeight: '32px' });
      expect(onOpen).not.toHaveBeenCalled();
    }
  );
});
