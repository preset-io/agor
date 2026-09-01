import type { User } from '@agor-live/client';
import { useCallback, useRef } from 'react';
import {
  discardMarketplaceOAuthStateForAuthority,
  type MarketplaceOAuthHandoffAuthority,
} from '../utils/marketplaceOAuthPrompt';

export type BeforeAuthGenerationChange = (
  previousGeneration: number,
  nextGeneration: number
) => void;

interface MarketplaceOAuthAuthorityOwner {
  beforeAuthGenerationChange: BeforeAuthGenerationChange;
  /** Ref-only render observation; performs no storage mutation or cleanup. */
  observeRenderedGeneration: (generation: number) => void;
}

/**
 * Own the complete Marketplace browser authority above every routed surface.
 *
 * `useAgorClient` invokes this callback synchronously before it publishes a
 * newly authenticated generation to React. Consequently an old generation's
 * handoffs, suggestions, and held claim flights are gone before any child can
 * render or run an effect for the new authority. Ordinary App rerenders do
 * nothing; identity/role/logout cleanup remains centralized in `useAuth`.
 */
export function useMarketplaceOAuthAuthorityOwner(
  user: Pick<User, 'user_id' | 'role'> | null
): MarketplaceOAuthAuthorityOwner {
  const identityRef = useRef(user);
  identityRef.current = user;
  const establishedAuthorityRef = useRef<MarketplaceOAuthHandoffAuthority | null>(null);

  const beforeAuthGenerationChange = useCallback(
    (previousGeneration: number, nextGeneration: number) => {
      const identity = identityRef.current;
      const previous = establishedAuthorityRef.current;
      if (previous) {
        discardMarketplaceOAuthStateForAuthority(previous);
      } else if (identity && previousGeneration !== nextGeneration) {
        // Covers adoption/HMR where the connection hook retained its generation
        // but this small owner was remounted without its prior ref.
        discardMarketplaceOAuthStateForAuthority({
          userId: identity.user_id,
          role: identity.role,
          authGeneration: previousGeneration,
        });
      }

      establishedAuthorityRef.current = identity
        ? {
            userId: identity.user_id,
            role: identity.role,
            authGeneration: nextGeneration,
          }
        : null;
    },
    []
  );

  const observeRenderedGeneration = useCallback((generation: number) => {
    const identity = identityRef.current;
    establishedAuthorityRef.current = identity
      ? {
          userId: identity.user_id,
          role: identity.role,
          authGeneration: generation,
        }
      : null;
  }, []);

  return { beforeAuthGenerationChange, observeRenderedGeneration };
}
