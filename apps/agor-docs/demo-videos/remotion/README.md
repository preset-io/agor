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
4. Render: `npm run render:teammates` writes `out/ai-teammates.mp4`.

## Compositions

- **AiTeammates** (`src/teammates/`): "AI teammates that can do anything".
  - Four teammates (DataBot, EngBot, LegalBot, OpsBot) answer real questions.
  - Each question is typed close up, then the camera glides to the answer.
  - The shot then shrinks into a corner of a 2x2 grid while the next one is
    asked, and the piece ends on all four under a title.
  - Timing comes from the clips' marks (`question`, `sent`, `answered`).
  - Camera views are rectangles in the recorded window's CSS pixels
    (`geometry.ts`).

## Agent skills

Remotion publishes official agent skills (`remotion-best-practices` and
friends). They aren't vendored here; install them locally into
`.claude/skills/` (git-ignored):

```console
npx skills add remotion-dev/skills
```
