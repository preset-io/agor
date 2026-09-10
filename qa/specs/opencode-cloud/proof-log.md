# Local proof log — OpenCode storage, durability, and cancellation inputs

Performed 2026-09-10 on macOS (darwin-arm64) with the pinned `opencode`
1.14.33 executable resolved from the workspace `node_modules`
(`opencode-darwin-arm64@1.14.33`). No provider credentials, no network beyond
loopback. These are developer verification results that informed the storage
decision in the design; they are **not** Cloud acceptance evidence.

## Run 1 — `local-spike-storage.mjs`

| Step                                                                                | Observation                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve` with `XDG_*` under a private home and `OPENCODE_DB` in a separate directory | Startup printed the one-time migration banner (marker check reads the XDG data root), then `opencode server listening on http://127.0.0.1:<port>`                                                                                                        |
| `POST /session`                                                                     | 200, session id returned                                                                                                                                                                                                                                 |
| `PUT /auth/anthropic` with a placeholder API key                                    | 200; `auth.json` (80 B, mode 0600 by OpenCode) written under `<XDG_DATA_HOME>/opencode/`, not next to the database                                                                                                                                       |
| Native file inventory after one session + one key                                   | `data/opencode/auth.json`, `data/opencode/log/<ts>.log`, `xdg-config/opencode/.gitignore`, `xdg-state/opencode/locks/<hash>.lock/{heartbeat,meta.json}`; database directory: `opencode.db` (4 KB), `opencode.db-shm` (32 KB), `opencode.db-wal` (206 KB) |
| `SIGKILL` the server                                                                | Files unchanged                                                                                                                                                                                                                                          |
| Copy only `opencode.db`, query with sqlite3                                         | `no such table: session` — the main file held no schema before the first checkpoint                                                                                                                                                                      |
| Copy `opencode.db` + `-wal`, query                                                  | 1 session row                                                                                                                                                                                                                                            |
| Restart with the same files, `GET /session/<id>`                                    | 200, same id (committed data survived SIGKILL)                                                                                                                                                                                                           |
| `GET /session/ses_doesnotexist`                                                     | 404                                                                                                                                                                                                                                                      |
| After `SIGTERM`                                                                     | Main file 168 KB, WAL 4 KB (the restart's `wal_checkpoint(PASSIVE)` moved data into the main file)                                                                                                                                                       |
| Restart **without** `OPENCODE_DB`                                                   | `GET /session/<id>` 404; a fresh `opencode.db` was created under the XDG data root (proves `OPENCODE_DB` placement, no accidental sharing)                                                                                                               |

## Run 2 — `local-spike-concurrency.mjs`

| Step                                                                 | Observation                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two `serve` processes on one `OPENCODE_DB`                           | Startup 1354 ms and 1066 ms; both created sessions (2 rows); server A could read server B's session — SQLite provides **no** single-writer fence |
| Close server A with `SIGTERM`                                        | WAL 53 KB remained (no checkpoint at exit)                                                                                                       |
| `PRAGMA wal_checkpoint(TRUNCATE)` on the closed files                | `0                                                                                                                                               | 0   | 0`; WAL 0 bytes |
| Copy only `opencode.db` after checkpoint                             | 2 session rows, `integrity_check` ok                                                                                                             |
| Start a third server on that single copied file in a fresh directory | `GET /session/<id from A>` 200 — resume from a checkpointed single file works                                                                    |

## What this does and does not establish

Established: `OPENCODE_DB` separates only the database; credentials stay in the
XDG data home; committed transactions survive process kill; a main-file-only
copy before checkpoint is unusable; checkpoint-then-copy yields a single
consistent, resumable file; SQLite is not a writer fence.

Not established (Cloud QA): fsync behavior on FSx ONTAP / EFS, cross-node
resume, full-disk behavior during checkpoint, Job cancellation timing, and any
behavior involving a real provider.
