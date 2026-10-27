# What's new visuals

Images for the in-app What's new modal, served from `https://agor.live/whats-new/`.

- One light and one dark file per highlight: `<topic>-light.svg` and `<topic>-dark.svg`.
- 640 × 320 (2:1), SVG or WebP, no text that needs translating beyond short labels.
- The app falls back to text only when an image fails to load, so the copy must stand on its own.

## Self-hosted highlights

`highlights.json` promotes a released CHANGELOG entry to a `major` item (eligible for the modal),
keyed by its preset-io/agor PR number. Every other released Features/Fixes/Security/Breaking entry
ships as an `update` (bell and agents only). The daemon build reads this file with `CHANGELOG.md`
(`apps/agor-daemon/scripts/build-release-notes.mjs`).

Each entry may set `tier`, `audience`, `title`, `subtitle`, `agent_brief`, `docs_url`,
`visual_url`, `visual_url_dark`, `cta_label` and `cta_path`. URLs must be `https://`. `cta_path` is
an in-app path such as `/b/:currentBoard/`; `:currentBoard` and `:mainBoard` are resolved for the
user. An entry has no effect until its PR appears in a released CHANGELOG section.

Agor Cloud publishes its own notes and does not use this file.
