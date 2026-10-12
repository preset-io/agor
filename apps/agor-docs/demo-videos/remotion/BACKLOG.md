# Video edit backlog

Ideas parked for later passes, once more parts of the reel exist. Not
blocking anything.

## Sound

- A music bed, with cuts and pane lock-ins landing on the beats (Remotion
  handles audio and can time sequences to it).
- Small sound effects: the name-card wipe, a pane locking into place.

## Look

- Bebop-style texture: halftone and film grain over the color blocks.
- A tilted camera, or slight parallax, on the pane spread.
- Letter-by-letter or staggered type on the title and name cards.
- A light leak or flash when each pane locks into place
  (`remotion-markup` has a light-leaks recipe).

## Content and tuning

- Per-bot tuning of what each pane shows (scroll the panel view to the most
  telling part of the answer: tables, the PR link, the redline).
- On-screen captions of each question during the prompt close-up, for
  sound-off viewing.
- OpsBot's board shows an empty "AI teammates" zone (OpsBot is the board's
  primary teammate, so it lives in the side panel): drop the zone, or seed
  something there.
- Typing speed versus readability in the prompt close-ups.

## Workflow

- Storyboard each new section first: a one-page frame sheet of beats and
  timings to approve before building (most revision rounds were structural).
- Timestamped notes: review in Remotion Studio (`npm run dev`) and quote
  frame numbers, which map straight to code.
- `npm run review <Composition>`: render a section and publish a private
  review page (contact sheets plus a still per beat) that takes comments.
- Iterate on half-resolution single-section renders; full reel at the end
  of a round.
- Move sections 1 and 2 to beats-as-data, like RaiseTogether's `PILLARS`.
- `npm run scout -- <seed> <paths...>` in ../e2e: the throwaway screenshot
  pass as a tool, so planning a UI section starts from every screen.
- Before anyone else sees the project: the Remotion company license.
