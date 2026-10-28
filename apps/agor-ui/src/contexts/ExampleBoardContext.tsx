import type { ExampleBoardAnalyticsSource } from '@agor-live/client';
import { createContext, useContext } from 'react';

export interface ExampleBoardActions {
  /** Current user, for product analytics. */
  userId?: string;
  /** The person hid the example board for themselves. */
  hidden: boolean;
  /** Opens onboarding, or the person's own teammate board when they have one. Absent for viewers. */
  makeYourOwn?: (source: ExampleBoardAnalyticsSource) => void;
  /** Confirms, hides the example for this person only, and offers undo. */
  hide: () => void;
}

const ExampleBoardContext = createContext<ExampleBoardActions | undefined>(undefined);

export const ExampleBoardProvider = ExampleBoardContext.Provider;

export const useExampleBoardActions = () => useContext(ExampleBoardContext);
