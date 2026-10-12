import type { LandingPageId } from '../pages';
import { boardDetails } from './board';
import { commandCenterDetails } from './command-center';
import { governanceDetails } from './governance';
import { multiplayerDetails } from './multiplayer';
import { teammatesDetails } from './teammates';
import type { LandingDetail } from './types';

export const LANDING_DETAILS: Record<LandingPageId, LandingDetail[]> = {
  multiplayer: multiplayerDetails,
  board: boardDetails,
  teammates: teammatesDetails,
  'command-center': commandCenterDetails,
  governance: governanceDetails,
};
