# Feature highlights

`highlights.json` is the in-app copy for user-visible features. Add an entry in the PR that ships
the feature, keyed by its preset-io/agor PR number. Self-hosted daemons show it in the bell (and the
pop-up) once the PR appears in a released `CHANGELOG.md` section; Agor Cloud seeds its drafts from
the same file. Check it with `pnpm check:whats-new-highlights` (CI runs it).

Every field is optional; missing ones come from the CHANGELOG entry (Features are `new` and ring
the bell, everything else is a quiet `improved`). The schema is `featureAnnouncementHighlightsSchema`
in `packages/core/src/types/feature-announcements.ts`.

```json
"3135": {
  "kind": "new",
  "title": "Zones can arrange your cards",
  "one_line": "Pick a row, a column or a grid and cards snap into place.",
  "learn_more_url": "https://agor.live/guide/boards#zone-layout",
  "visual": { "type": "illustration", "key": "zone-grid" },
  "visual_alt": "Scattered cards snap into a grid inside a zone.",
  "button": { "action": "agor_page", "target": "board", "label": "See it on my board" },
  "badge": true,
  "popup": true,
  "roles": "everyone",
  "agent_brief": "What it does, when to suggest it, and how (UI path or MCP tool)."
}
```

- `title` up to 60 characters, `one_line` up to 120. Plain language, sentence case.
- `visual`: an illustration (`zone-grid`, `channels`, `screenshot-frame`) or
  `{ "type": "media", "url", "url_dark", "mime" }` for a picture or muted looping video served from
  `https://agor.live/whats-new/` (put the file in this folder). Media needs `visual_alt`.
- `button`: `agor_page` (`board`, `integrations`, `mcp`, `teammates`, `models`, `artifacts`),
  `link`, or `teammate_chat` with a prefilled `message`.
- `popup` is for big launches only (about two a quarter). `badge: false` keeps an item quiet.
- `roles: "admins"` hides it from members. `new_until` (ISO time) ends the New marker early or
  late; the default is 30 days after the release.
