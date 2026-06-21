# Marketing screenshot staging

This folder contains demo-only screenshots for `agor.live` landing-page / homepage visuals.

## Demo route

The UI fixture lives at:

```txt
/demo/marketing-screenshots
```

It is intentionally hardcoded and daemon-free. `apps/agor-ui/src/App.tsx` short-circuits this explicit route before auth, client, or live workspace data hooks mount, so the fake board state cannot leak into normal production workspace paths. Presence and cursor screenshot data is passed through explicit `staticActiveUsers` / `staticCursors` demo props on the base components.

## What it renders

- Polished navbar using the real `GlobalPresenceFacepile`/`Facepile` components with fixed demo users
- Large board canvas with zones, branch cards, session progress, comments, artifacts, and the real `RemoteCursorLayer` with fixed demo cursors
- Left activity/sidebar and event stream overlay for a dense landing-page composition

## Captured files

- `context/marketing/screenshots/agor-marketing-board.png` — 1600×1000 crop for quick previews
- `context/marketing/screenshots/agor-marketing-board-wide.png` — 2200×1300 wide hero composition
- Public docs copies:
  - `apps/agor-docs/public/screenshots/marketing/agor-marketing-board.png`
  - `apps/agor-docs/public/screenshots/marketing/agor-marketing-board-wide.png`

## Reproduce/update

From the repo root:

```bash
pnpm install --frozen-lockfile
# If packages/client/dist is missing in a fresh worktree, run this in a temp terminal
# and stop it after Vite starts successfully:
pnpm --filter @agor-live/client dev

pnpm --filter agor-ui dev --host 127.0.0.1 --port 5173

mkdir -p context/marketing/screenshots apps/agor-docs/public/screenshots/marketing

google-chrome --headless --disable-gpu --no-sandbox \
  --window-size=1600,1000 --hide-scrollbars --virtual-time-budget=5000 \
  --screenshot=context/marketing/screenshots/agor-marketing-board.png \
  http://127.0.0.1:5173/demo/marketing-screenshots

google-chrome --headless --disable-gpu --no-sandbox \
  --window-size=2200,1300 --hide-scrollbars --virtual-time-budget=5000 \
  --screenshot=context/marketing/screenshots/agor-marketing-board-wide.png \
  http://127.0.0.1:5173/demo/marketing-screenshots

cp context/marketing/screenshots/agor-marketing-board*.png \
  apps/agor-docs/public/screenshots/marketing/
```

The Chrome DBus warnings in headless Linux are harmless if the PNG is written.
