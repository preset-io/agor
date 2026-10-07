'use client';

import { BoardSection } from './landing/BoardSection';
import { CommandCenterSection } from './landing/CommandCenterSection';
import { CrtIntro } from './landing/CrtIntro';
import { CursorTroupe } from './landing/CursorTroupe';
import { GovernanceSection } from './landing/GovernanceSection';
import { HomeHero } from './landing/HomeHero';
import { LandingShell } from './landing/LandingShell';
import { MultiplayerSection } from './landing/MultiplayerSection';
import { ProblemSection } from './landing/ProblemSection';
import { RosterSection } from './landing/RosterSection';
import { TeammatesSection } from './landing/TeammatesSection';

/**
 * Hub page. The hero's links fan out to each landing page (most visitors
 * never scroll, so those clicks show which stories matter); below it, each
 * section is a sampler that hands off to its landing page.
 */
export function LandingPage() {
  return (
    <LandingShell ctaPrefix="landing">
      {/* Flagged (?intro=true): the locked CRT intro. See lib/crtIntro.ts. */}
      <CrtIntro />
      <HomeHero />
      {/* On by default; ?cursors=off turns it off. See CursorTroupe.tsx. */}
      <CursorTroupe />
      {/* Positioning order (M&P v4): the board first, so the product shows
          early; the problem cards as the bridge into Multiplayer AI; then
          teammates with the roster as their proof, the builder's command
          center, and the trust story. */}
      <BoardSection sampler />
      <ProblemSection />
      <MultiplayerSection sampler />
      <TeammatesSection sampler />
      <RosterSection sampler />
      <CommandCenterSection sampler />
      <GovernanceSection sampler />
    </LandingShell>
  );
}
