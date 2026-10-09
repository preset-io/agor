# context/

Agent-oriented contracts, pitfalls, and house rules that are not derivable from code. User and
operator documentation lives in [`apps/agor-docs/content/guide/`](../apps/agor-docs/content/guide/);
link to it instead of duplicating it. Code wins when a doc here drifts.

Keep this folder small. Investigation reports, audits, plans, and validation evidence belong in the
issue or PR; git history keeps deleted docs.

## `concepts/` — how the system works and what must stay true

| File                                                                        | Covers                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`core.md`](concepts/core.md)                                               | The primitives (Branch, Board, Session, Task, Report).                    |
| [`architecture.md`](concepts/architecture.md)                               | System shape and where to look first.                                     |
| [`branches.md`](concepts/branches.md)                                       | Branch-centric boards (read before touching boards).                      |
| [`id-management.md`](concepts/id-management.md)                             | UUIDv7, branded ID types, short-ID resolution.                            |
| [`multitenancy.md`](concepts/multitenancy.md)                               | Tenant triggers, resource classification, code owners, proof.             |
| [`security.md`](concepts/security.md)                                       | CSP, CORS, and daemon-wide git config hardening.                          |
| [`daemon-filesystem-boundary.md`](concepts/daemon-filesystem-boundary.md)   | Daemon-host filesystem capability guard.                                  |
| [`task-queueing.md`](concepts/task-queueing.md)                             | Task lifecycle and queue-on-busy semantics.                               |
| [`task-runtime-state.md`](concepts/task-runtime-state.md)                   | Task states, executor liveness, pulses, watchdogs, and containment.       |
| [`session-sharing.md`](concepts/session-sharing.md)                         | Shared session prompting: gates, compatibility, caller identity.          |
| [`mcp-session-tools.md`](concepts/mcp-session-tools.md)                     | `agor_sessions_*` MCP tool surface and override semantics.                |
| [`mcp-catalog.md`](concepts/mcp-catalog.md)                                 | Curated catalog, Connect probes, OAuth/bearer reuse, disclosure contract. |
| [`mcp-egress-gateway.md`](concepts/mcp-egress-gateway.md)                   | Daemon-owned MCP egress: credential boundary and admission contract.      |
| [`discord-gateway.md`](concepts/discord-gateway.md)                         | Discord gateway: provider-owned history, cursor, and admission contract.  |
| [`teams-gateway.md`](concepts/teams-gateway.md)                             | Teams gateway: verified ingress, admission fence, identity, delivery.     |
| [`opencode-hosted.md`](concepts/opencode-hosted.md)                         | Hosted OpenCode capability gate and checkpointed native state.            |
| [`user-first-scoped-hydration.md`](concepts/user-first-scoped-hydration.md) | Browser data layers: user scope, board partitions, on-demand reads.       |

## `guides/` — procedures

- [`extending-feathers-services.md`](guides/extending-feathers-services.md) — services, methods, hooks.
- [`creating-database-migrations.md`](guides/creating-database-migrations.md) — Drizzle migrations (SQLite + Postgres).
- [`rbac-and-unix-isolation.md`](guides/rbac-and-unix-isolation.md) — branch RBAC and simple/sandbox/delegated execution.
- [`migrate-strict-to-sandbox.md`](guides/migrate-strict-to-sandbox.md) — operator runbook for the 0.24.7 → 0.25.1 `strict`/`insulated` → `sandbox` cutover.
- [`gemini-live-smoke.md`](guides/gemini-live-smoke.md) — the live Gemini smoke workflow.
- Releases and SDK bumps: [`PUBLISH.md`](../PUBLISH.md).

## `guidelines/` — house rules

- [`constants.md`](guidelines/constants.md) — ownership and reuse of shared runtime identifiers.
- [`frontend.md`](guidelines/frontend.md) — AntD-first components, tokens, themed modals, accessibility.
- [`toasts.md`](guidelines/toasts.md) — always `useThemedMessage()`.
- [`logging.md`](guidelines/logging.md) — safe, bounded operational logging.
- [`testing.md`](guidelines/testing.md) — Vitest patterns.
- [`onboarding-design.md`](guidelines/onboarding-design.md) — onboarding wizard: goal-over-role framing.

Product copy, voice, and positioning live in the Agor team Knowledge base
([`marketing/messaging-and-positioning`](https://agor.sandbox.preset.zone/kb/agor-cloud-team/marketing/messaging-and-positioning.md)),
not in this repo.
