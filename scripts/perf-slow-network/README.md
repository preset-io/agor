# Slow-network UI benchmark

Measures how the production UI bundle and daemon behave over a VPN-like link:
a cold or warm `/s/<id>` open (large transcript) and a board open, on a
synthetic workspace the size of a busy single-tenant install.

Everything runs against scratch daemons on ports 4420+ with an isolated
`HOME`; it never touches `~/.agor` or a running dev daemon.

## What it measures

`run-bench.mjs` starts one daemon per build (packaged layout: the daemon serves
the built UI from `dist/../ui`, with its real compression and cache headers),
puts `throttle-proxy.mjs` in front of it, and drives Chromium through
Playwright.

The proxy shapes **every TCP byte** in both directions: one shared FIFO link per
direction with fixed bandwidth, a fixed one-way delay, and two extra round trips
per new connection (TCP + TLS). CDP network throttling does not shape WebSocket
frames reliably, and nearly all Agor data rides the Socket.IO WebSocket.

| Profile |    RTT |     Down |        Up |
| ------- | -----: | -------: | --------: |
| `vpn`   | 150 ms |   5 Mbps |    2 Mbps |
| `harsh` | 300 ms | 1.5 Mbps | 0.75 Mbps |
| `none`  |      0 | unshaped |  unshaped |

Per run (median of `--reps`):

Session opens use the full session id. The seed creates sessions seconds
apart, so their 8-character short ids (a UUIDv7 time prefix) collide.

- **Paint**: the target first appears in the DOM and any loading overlay is at
  least half faded. For a session, that is the newest turn's prompt inside the
  conversation pane. For a board, it is the first branch card.
- **TTI**: paint, or the end of the load's last main-thread long task if later.
- **Settled**: the last byte of the load crossed the link, followed by 3 s of
  quiet.
- **Down / up**: bytes on the wire, measured at the proxy. This covers HTTP
  bodies and WebSocket frames, after compression.
- **HTTP**: requests that crossed the network (cache hits excluded).
- **WS in/out**: Socket.IO frames.
- **Long tasks**: count and total duration (ms).

`cold` uses a fresh browser context. `warm` primes the HTTP cache with one
untimed load, then measures a reload.

The web-font stylesheet (`fonts.bunny.net`) is the only request allowed
around the proxy; any other request that bypasses the proxy fails the run.
Everything is served over HTTP/1.1 (six connections per origin), like a
daemon reached directly. Behind an HTTP/2 proxy, many small chunk requests
queue less.

## Running it

```bash
# 1. Build each tree to compare (production UI + daemon):
NODE_ENV=production pnpm turbo run build --filter=@agor/daemon --filter=agor-ui --filter=@agor/cli

# 2. Seed a synthetic workspace once (~3 min). It holds ~1,200 sessions
#    (~400 active), ~70 active and ~460 archived-but-placed branches, ~710
#    placements, 180 cards, 12 boards, 150 comments and ~18k messages, with
#    heavy custom_context. No real data.
scripts/perf-slow-network/prepare-seed.sh /tmp/agor-bench-seed-home

# 3. Run. Each --target is name=<worktree>; worktrees can sit at any commit.
node scripts/perf-slow-network/run-bench.mjs \
  --target main=/tmp/agor-bench-main \
  --target this=. \
  --seed-home /tmp/agor-bench-seed-home \
  --reps 3 --profiles vpn,harsh --out /tmp/bench.json
```

The runner also takes these flags:

- `--scenarios session,board` (add `session-reconnect` / `board-reconnect`
  to load, wait for quiet, drop every connection like a VPN blip, and
  measure the resync)
- `--cache cold,warm`
- `--screenshots <dir>` saves the final frame of each run.
- `--trace` records, per run, each Socket.IO request/ack, the HTTP waterfall
  and long tasks into `--out`. Use it to see what a load waits on.
