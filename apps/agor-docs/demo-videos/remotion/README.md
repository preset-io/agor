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

- **AiTeammatesBebop** (`src/teammates/Bebop.tsx`): "AI teammates that can
  do anything", Cowboy Bebop-style.
  - Opens with the Agor logo draw-on, then a title slam of two color blocks.
  - Four rapid questions: a bot name card wipes across, the prompt is typed
    close up with the name on screen, and on send the shot shrinks into a
    slanted colored pane holding the sent question.
  - Then all four panes play their real answers side by side.
  - Ends on the logo and the title.
  - Timing comes from the clips' marks (`question`, `sent`, `answered`);
    pacing constants sit at the top of the file.
- **AiTeammatesGrid** (`src/teammates/AiTeammates.tsx`): the first try, a
  2x2 Brady Bunch grid. Kept for comparison.

## Agent skills

Remotion publishes official agent skills (`remotion-best-practices` and
friends). They aren't vendored here; install them locally into
`.claude/skills/` (git-ignored):

```console
npx skills add remotion-dev/skills
```
