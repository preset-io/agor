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
4. Render: `npm run render:teammates` writes `out/ai-teammates-bebop.mp4`.

## Compositions

- **AiTeammatesBebop** (`src/teammates/Bebop.tsx`, `Slices.tsx`): "AI teammates
  that can do anything", Cowboy Bebop-style.
  - The Agor logo draws on, then four colored slanted slices slam in under the
    title.
  - Each slice is a color with its teammate's name centered in it; the name
    grows with the slice, and a strip too narrow for it shows just the emoji.
  - Accordion: each slice opens in turn (to about 85% of the width) while its
    question is typed. Its recording slides up from the bottom, pushing the
    name up into a header bar. As the next opens, the recording slides up
    and off, leaving a plain colored strip.
  - The slices even out and every recording slides back up into a band under
    its header, showing the whole session while the answers play. As each
    answer lands, its band pushes in on the telling part of the reply and a
    one-line takeaway wipes on below it.
  - The slices slide off, alternately up and down, to black.
  - Standalone, ends on a logo-only sign-off.
- **Interfaces** (`src/interfaces/`): "Access Agor from where you work".
  - From black, the title's words rise in alone; four comic-panel color
    segments (an off-axis cross of black gutters) spin in behind it, and each
    app's mark pops on, on a white tile (official marks from the CC0 `logos`
    icon set, unaltered).
  - One by one each segment crops down to its name and slides it into the
    panel's corner as its label, uncovering the same question to EngBot from
    Slack, Discord, Claude Desktop (through Agor's MCP server) and Agor.
  - Slack, Discord and Claude Desktop are hand-rolled stages (`stages.tsx`)
    in each app's visual grammar, not pixel clones. The Agor panel is the
    real EngBot clip. Fades to black.
- **TeammatesReel** (`src/Reel.tsx`): the AI teammates segment, then
  Interfaces, then one end card.
- **AiTeammatesGrid** (`src/teammates/AiTeammates.tsx`): the first try, a
  2x2 Brady Bunch grid. Kept for comparison.

## Agent skills

Remotion publishes official agent skills (`remotion-best-practices` and
friends). They aren't vendored here; install them locally into
`.claude/skills/` (git-ignored):

```console
npx skills add remotion-dev/skills
```
