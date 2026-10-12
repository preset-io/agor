---
name: agor-reel
description: Edit Agor sizzle reels, trailers and website edits in Remotion (apps/agor-docs/demo-videos/remotion) from real-app clips: section structure, the brand look (palette, wordmark, type), camera framing on 4K recordings, timing from clip marks, the render-and-review loop, and the motion-design lessons from Evan's director notes. Use after the clips exist (demo-videos skill); start at agor-video if unsure.
---

# Agor reel editing (Remotion)

The edit lives in `apps/agor-docs/demo-videos/remotion/`: one composition
per section plus `TeammatesReel` (`src/Reel.tsx`), which chains them and ends
on the wordmark. The README there lists each composition and what it does.
Remotion's official agent skills install locally (`npx skills add
remotion-dev/skills`, git-ignored); load them for API details.

**License:** Remotion is free for individuals only. Preset needs a company
license before anyone else uses this project or it merges to `main`.

## Workflow

1. **Capture** real clips in `../e2e` (`demo-videos` skill), usually
   `npm run clip -- <id> --snappy`. Mark every beat the edit will cut on
   (`studio.mark('label')`).
2. **Sync**: `npm run sync` copies the raw 4K cuts into `public/clips/`
   (git-ignored) and writes the marks to `src/<section>/marks.json`
   (committed). Add new clip families to `scripts/sync-clips.mjs`.
3. **Edit**: time everything from marks and named constants, never magic
   frame numbers. Each section exports its length (`*_SECONDS`) so the
   reel's sequences chain.
4. **Render** the section on its own (`npx remotion render <Id>
out/<file>.mp4`), then the reel. Copy finished renders to
   `~/Desktop/agor_video/reel/`.
5. **Review** (below), then commit and push each finished round of notes.

## Reviewing renders (you can't watch video)

- **Contact sheets**: `ffmpeg -i out.mp4 -vf "fps=2,scale=480:-1,tile=6x6"
-frames:v 1 sheet.png`, then Read. 1 fps for structure, 4-20 fps over a
  short window for motion (`-ss <t> -t <d>` before `-i`).
- **Full-size stills** for anything typographic or framed tightly.
- **Seek accurately when choosing source times.** `-ss` before `-i` on a
  long-GOP clip can land on a keyframe seconds away; a frame-picking sheet
  once showed EngBot's table ~2 s early. Confirm with `-i clip -ss <t>`
  (decode-accurate) before committing a `trimBefore`.
- `tile=` only writes a sheet once every cell is filled: give `-t` a
  little extra or you get no file and no error.
- A dark frame on a 1 fps sheet is often a cross-fade or a fade; check a
  still before "fixing" it.
- Say what you checked and what you couldn't (feel, rhythm). Never claim
  motion "works" from sparse stills.

## Brand look

- **Palette**: agor.live's dark look, `src/brand/palette.ts` (from
  `apps/agor-docs/components/LandingPage.module.css` on `main`). Background
  `#07100f`, ink `#eafff9`. Big color blocks use rich gradient fills that
  run green → teal → blue → indigo (`FILL_GREEN`, `FILL_TEAL`, `FILL_BLUE`,
  `FILL_INDIGO`, after the site's teammates ring) with white ink on top.
  Evan rejected, in turn: playful pink/yellow/blue; mostly-mint with lime;
  and pastel aqua/sky ("minty-gross", "lavender is odd", two near-identical
  greens). Keep fills saturated and clearly distinct; no pastels.
- **Type**: Hanken Grotesk, the site's heading face (`src/brand/fonts.ts`),
  in every composition. Headings follow the site's style with
  `<Heading text="Work *together* **again**" />` (`src/brand/Heading.tsx`):
  plain words are thin (100), `*accent*` is 600 with the teal→sky gradient,
  `**strong**` is 700 ink. Words can rise in one by one (`at`).
- **Slogan**: "Work together again" rises in under the wordmark at the
  start (`LogoIntro`).
- **Wordmark**: `src/brand/AgorWordmark.tsx`. The mark is a frame-driven
  port of `../animated_agor_logo/index_4k.html` (same paths, keyframes,
  easings); the "agor" letters are crops of the flat lockup PNG in
  `public/wordmark/`. Letters crash in from the right like the problem
  cards on agor.live, overlap and squash, then spring back. Use
  `<AgorWordmark t={WORDMARK_SETTLED + 1} />` for a static sign-off.
- **Logos** of third-party apps: official marks from the CC0
  `@iconify-json/logos` set, unaltered, on white tiles.
- **Copy**: Messaging & Positioning rules (no em-dashes; never "open
  source"). Takeaways and lines are short and concrete.

## Camera on a recording

Recordings are 4K captures of a 1920x1080 app. Frame them with a camera
`{cx, cy, z}`: app-space center and zoom (output px per app px). Position a
`1920*z x 1080*z` box at `left = viewCx - cx*z`, `top = viewCy - cy*z`, and
clamp the center so the view never leaves the recording. Ease between
cameras with `Easing.bezier(0.45, 0, 0.55, 1)` for pans and
`Easing.bezier(0.16, 1, 0.3, 1)` for entrances.

- Read coordinates off gridded reference frames
  (`drawgrid=w=48:h=54` on a 960-wide frame = 96x108 app px cells).
- Typing: zoom close (z 3.5-4.5 on a wide slice) on the input row, with the
  text starting near the left edge of the view. Readability beats context.
- Answers: frame the left third of the reply, where its structure (tables,
  headings) shows; go straight there from the prompt close-up rather than
  through a wide shot.
- Trim waits out of the source (`trimBefore` after the thing appears), not
  with speed alone; an empty panel reads as dead air.
- End a beat before the page navigates: UI clips contain boot screens and
  empty states between pages (`actor.open()`), and they read as broken
  product. Check each beat's last second on a decode-accurate sheet.
- Takeaways or captions that belong together land together (stagger them a
  little), not each on its own clip's schedule.

## Motion lessons (Evan's director notes)

- **One element per idea.** No duplicate labels (a name in the slice and a
  tag chip), no horizontal-to-vertical text swaps, no ghost copies while
  something resizes. Text grows and recenters with its container.
- **Nothing blinks on.** Every element enters with motion that has a cause:
  video slides in and pushes the label ahead of it; panels crop down into
  their labels; titles rise word by word.
- **Leave clean.** When something collapses, its content exits (slides up
  and off), leaving a plain color bar, not a sliver of cropped UI.
- **Sections start and end on black**, or with a deliberate move (slices
  sliding off alternately up and down). The next section's title comes on
  alone, then its graphics build behind it.
- **Titles must not cover content.** Bring supporting labels (bot names) on
  after the title, below it.
- **Highlight the insight, not the question.** Under a result, show a
  one-line takeaway of what the agent did, written from the real answer.
- **Vary the compositing style per section** (accordion slices, comic-panel
  quadrants, word-plus-window) so the reel doesn't repeat itself.
- Keep a `BACKLOG.md` of ideas Evan parks (sound, texture) instead of doing
  them unasked.

## Sections so far

| Composition        | Look                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| `AiTeammatesBebop` | Wordmark crash, then four slanted slices as an accordion over real Q&A clips |
| `Interfaces`       | Comic-panel quadrants spin in; each crops to its label over a chat stage     |
| `RaiseTogether`    | Rolling pillar word on the left, the real UI in a window with camera beats   |

## Gotchas

- `@remotion/media` `<Video>`: `trimBefore` is in composition frames of
  source time; `playbackRate` scales after it. Freeze a frame with
  `<Freeze frame={0}>` inside a `Sequence`.
- Pre-roll a `Sequence` (negative offset) when a clip must be on screen
  before its beat starts, and `premountFor={fps}` everything.
- zsh doesn't word-split `$var`: loop over explicit args or arrays when
  rendering several compositions.
- Biome runs in the pre-commit hook (`biome ci`): run `npx biome check
--write src` before committing; never `--no-verify`.
