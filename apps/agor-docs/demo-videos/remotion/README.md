# Agor video edits (Remotion)

Edits of Agor's real-app clips (recorded by [`../e2e`](../e2e)) for the trailer,
sizzle reel and website, as [Remotion](https://www.remotion.dev) compositions.

> **License:** Remotion is free for individuals and companies of up to 3
> people. This project is an individual experiment for now. Before anyone else
> uses it, or it merges to `main`, Preset needs a
> [company license](https://remotion.pro/license).

## Workflow

1. Record or re-shoot the clips in `../e2e` (see the `demo-videos` skill). For
   reel use, export the snappy cut:
   `npm run clip -- teammate-databot --snappy` (and the same for the others).
2. Pull them in: `npm run sync`. This copies the 4K tight raw cuts into
   `public/clips/` (git-ignored) and their marks into `src/teammates/marks.json`.
3. Preview and edit: `npm run dev` (Remotion Studio).
4. Render a section (`npm run render:teammates`, `render:interfaces`,
   `render:raise`, `render:throughput`) or the whole reel (`render:reel`,
   `render:reel-4k`) into `out/`.

## Compositions

Colors follow agor.live's dark palette (`src/brand/palette.ts`). The
wordmark letters in `public/wordmark/` are cut from the flat horizontal
lockup; the mark itself is a frame-driven port of
`../animated_agor_logo/index_4k.html`.

- **AiTeammatesBebop** (`src/teammates/Bebop.tsx`, `Slices.tsx`): "AI teammates
  that can do anything", Cowboy Bebop-style.
  - The Agor logo draws on and the "agor" letters crash in from the right,
    shoving the mark left into the centered wordmark (`src/brand/`); the
    slogan rises in and the cursor troupe (`src/brand/Cursors.tsx`, after
    agor.live's) swoops in to circle "together". Then four colored slanted
    slices slam in under the title and their names pop on, left to right.
  - Each slice is a color with its teammate's name centered in it; the name
    grows with the slice, and a strip too narrow for it is a plain bar.
  - Accordion: a cursor clicks each slice open in turn (to about 85% of the
    width) and taps along while its question is typed (sharp close-up stills
    from the take, one per key). Its recording slides up from the bottom, pushing the
    name up into a header bar. As the next opens, the recording slides up
    and off, leaving a plain colored strip.
  - The slices even out and every recording slides back up into a band under
    its header, framed close on the left side of the reply while the answers
    play. While they pour in, terse takeaways slide up under them, one at a
    time.
  - The slices slide off, alternately up and down, to black.
  - Standalone, ends on a logo-only sign-off.
- **Interfaces** (`src/interfaces/`): "Access Agor from where you work".
  - From black, the title's words rise in alone; four comic-panel color
    segments (an off-axis cross of black gutters) spin in behind it, and each
    app's mark pops on, on a white tile (official marks from the CC0 `logos`
    icon set, unaltered).
  - One by one a cursor clicks each app's mark and its segment crops down to its name and slides it into the
    panel's corner as its label, uncovering the same question to EngBot from
    Slack, Discord, Claude Desktop (through Agor's MCP server) and Agor.
  - Slack, Discord and Claude Desktop are hand-rolled stages (`stages.tsx`)
    in each app's visual grammar, not pixel clones. The Agor panel is the
    real EngBot clip. Fades to black.
- **RaiseTogether** (`src/raise/Raise.tsx`): "Raise AI teammates together".
  - From black, the title rises in. Then four pillars, each a big word on
    the left ("with personality", "shared memory", "capability", "agency")
    over a short line, rolling over to the next, and the real product on the
    right in a window, the camera easing over the UI beat by beat. The takes
    are cursorless; a troupe cursor rides each take's logged mouse path.
  - The clips are e2e `raise-<pillar>` (seed `teammates-together`: 13
    teammates, a ~200-page Handbook in Knowledge, EngBot's HEARTBEAT.md and
    schedules), captured with `npm run clip -- raise-<pillar> --snappy` and
    pulled in by `npm run sync`. Each beat is source seconds, a rate and a
    camera move in `PILLARS`.
  - Ends on black.
- **MultiplyThroughput** (`src/throughput/`): "Multiply engineering
  throughput" (multi-model, multi-backlog, multiplayer).
  - From black, the title and its three "Multi" words, each caught by a
    cursor. Then the real board, full screen with a subtle camera
    (`shots.tsx`): Maya asks EngBot for a kanban board and five issues (sharp
    typing stills), the zones and cards land from GitHub Issues and Jira,
    five people drag a card each into In Progress at once, and every drop
    starts a session.
  - "Put work on _autopilot_ with **Zones**": the zone prompt, then the hero
    card's loop through Review (Codex), back, QA and Ready while the cursors
    let go. "Parallelize sessions across models": a deep review with Claude
    Code, Codex, Gemini and Copilot children; the cursors carry those four
    harnesses in as tiles. Then the merge, everyone cheering, and Maya asks
    for 50 more tickets. Ends on black.
  - Clips are e2e `eng-build` (a real EngBot turn, replayed on a pinned
    seed), `eng-fanout` and `eng-flow` (the real board, staged over REST, with
    agents held "running"). See the `demo-videos` skill.
- **TeammatesReel** (`src/Reel.tsx`): the AI teammates segment, then
  Interfaces, RaiseTogether and MultiplyThroughput, then one end card.
- **AiTeammatesGrid** (`src/teammates/AiTeammates.tsx`): the first try, a
  2x2 Brady Bunch grid. Kept for comparison.

## Agent skills

Remotion publishes official agent skills (`remotion-best-practices` and
friends). They aren't vendored here; install them locally into
`.claude/skills/` (git-ignored):

```console
npx skills add remotion-dev/skills
```
