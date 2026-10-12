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
  - Accordion: each slice opens in turn (to about 85% of the width, the others
    squeezing into strips with vertical names) while its question is typed,
    its recording sliding up into it, clipped to the slanted shape. It closes
    as the next opens, its video cropped down with it.
  - The slices even out and each video settles into a slanted-edged band
    showing the whole session, name above and question below, while the
    answers play.
  - Ends on a logo-only sign-off.
- **Interfaces** (`src/interfaces/`): "Access Agor from where you work".
  - Four comic panels cut by an off-axis cross of black gutters start as
    color blocks with each app's mark (official marks from the CC0 `logos`
    icon set, unaltered) under the title.
  - One by one each recording wipes in from its panel's outer corner: the
    same question to EngBot from Slack, Discord, Claude Desktop (through
    Agor's MCP server) and Agor.
  - Slack, Discord and Claude Desktop are hand-rolled stages (`stages.tsx`)
    in each app's visual grammar, not pixel clones. The Agor panel is the
    real EngBot clip.
- **TeammatesReel** (`src/Reel.tsx`): the AI teammates segment hard-cut into
  Interfaces, with one end card.
- **AiTeammatesGrid** (`src/teammates/AiTeammates.tsx`): the first try, a
  2x2 Brady Bunch grid. Kept for comparison.

## Agent skills

Remotion publishes official agent skills (`remotion-best-practices` and
friends). They aren't vendored here; install them locally into
`.claude/skills/` (git-ignored):

```console
npx skills add remotion-dev/skills
```
