# Slack Table Rendering — Investigation Findings (2026-05-18)

**Status:** Recommendation ready. No code shipped from this worktree.
**Author:** Max (via Claude) — see worktree `investigate-slack-data-table-rendering`.
**Question asked:** Re-survey the landscape for rendering tabular data in Slack messages. Current state is `wrapTablesInCodeBlocks()` in `packages/core/src/gateway/connectors/slack.ts:102-142`, which wraps GFM tables in triple-backticks (PR #873). Columns don't align because nothing pads cell widths before the monospace wrap. **Hard constraint:** don't take ownership of a custom table-rendering library.

## TL;DR

**The landscape changed.** Slack shipped a native Block Kit `table` block on **Aug 14, 2025**, and rich_text gained markdown-table support on **Mar 6, 2026**. We can offload rendering to Slack entirely.

**Recommendation:** Add an adapter that emits Block Kit `table` blocks via `chat.postMessage(blocks: [...])` when a markdown table fits Slack's caps, with **per-table dynamic fallback** to the existing monospace section when it doesn't (>20 cols, >100 rows, oversize cell, or 2nd+ table — Slack allows one `table` block per message). When even the monospace fallback wouldn't fit (3000-char section cap), or when the message would exceed Slack's 50-block cap, drop `blocks` entirely and let the `text` field carry the message (40k-char budget; never truncated). CSV upload via `files.uploadV2` is deferred to a follow-up PR for tables too large for any block-based rendering.

This is **not** "owning a table library" — Slack owns the rendering. We emit ~50–100 LOC of JSON. The adapter is a markdown-table → JSON converter, the inverse shape of the existing detector.

## Phase 1 — What's actually available (verified May 2026)

### 1. Block Kit `table` block — **NEW since Aug 2025** ✅

Native, structured table block. Sent via `blocks` (or `attachments`) on `chat.postMessage`. Slack renders with proper alignment, column auto-sizing, sortable headers in modern clients.

```json
{
  "type": "table",
  "rows": [
    [
      { "type": "raw_text", "text": "Col 1" },
      { "type": "raw_text", "text": "Col 2" }
    ],
    [
      { "type": "raw_text", "text": "A" },
      { "type": "raw_text", "text": "B" }
    ]
  ]
}
```

- **Limits:** 100 rows × 20 columns; **one table per message**; `block_id` ≤ 255 chars.
- **Cell types:** `raw_text` (plain) or `rich_text` (bold/italic/links/mentions/emoji).
- **Column settings:** `align: left|center|right`, `is_wrapped: bool`.
- **Scopes:** no new scope — `chat:write` is sufficient.
- Docs: <https://docs.slack.dev/reference/block-kit/blocks/table-block/>

### 2. Block Kit `markdown` block (Feb 2025) and `rich_text` markdown-table support (Mar 2026)

The `markdown` block accepts raw markdown; Slack parses it. As of Mar 2026, rich_text added native rendering for tables, task lists, dividers, syntax-highlighted code, and headers from markdown sources. **Caveat:** Slack's own docs say "table rendering depends on the containing surface" — empirically unverified whether sending a GFM table in a `markdown` block round-trips to a Block Kit `table` block or stays as styled text. Plan: probe in PR 1 spike; if it works, the adapter shrinks to "wrap content in a `markdown` block." If not, use the explicit `table` block.

- Docs: <https://docs.slack.dev/reference/block-kit/blocks/markdown-block/>, <https://docs.slack.dev/changelog/2026/03/06/block-kit-rich-text/>

### 3. Slack Canvas — `canvases.create` + `channel_id`

Creates a canvas and attaches to a channel tab. Supports markdown tables in `document_content`. **Scope:** `canvases:write`. **Free-tier limitation:** free workspaces cannot create non-tabbed standalone canvases — `channel_id` must be set. Different UX surface (tab, not inline message). **Defer** — not the right shape for one-shot table output in a thread.

- Docs: <https://docs.slack.dev/reference/methods/canvases.create/>

### 4. CSV file upload (`files.uploadV2`)

`files.upload` is sunsetting (Mar 11, 2025 → Nov 12, 2025). Use `files.uploadV2` (or the sequenced pair `files.getUploadURLExternal` + `files.completeUploadExternal`). Slack renders an inline preview for CSV/TSV files; recipients can expand. **Scope:** `files:write`. **Status today:** gateway has **zero file-upload infrastructure** — would be a brand-new code path.

- Docs: <https://docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay/>

### 5. Monospace + column padding (the "small helper" alternative)

`~30 LOC padEnd` over parsed GFM rows would fix alignment in the current code path. **Disqualified** by the existence of native Block Kit table support — strictly worse for the same effort tier.

### 6. PNG rendering

Accessibility tax, copy-paste pain, infra tax. **Last resort. Not recommended.**

### 7. Third-party libraries — re-checked, none fit

| Lib                           | Last release     | Tables → native Block Kit table block?          |
| ----------------------------- | ---------------- | ----------------------------------------------- |
| `md-to-slack` (nicoespeon)    | v1.1.7, Dec 2025 | No — listed as "next features," not implemented |
| `markdown-to-slack-blocks`    | v1.4.1, Feb 2026 | No — emits "cell \| cell rows" as text          |
| `slackify-markdown` (current) | unmaintained     | Tables → code blocks (same as today)            |
| `slack-table`                 | 5 years stale    | No                                              |

**Conclusion:** no library yet emits the Aug-2025 native table block. We write the adapter or it doesn't exist.

## Phase 2 — Matrix

| Approach                                      | Native feel        | Maint. burden              | Edge cases                                      | Effort                | Verdict                                  |
| --------------------------------------------- | ------------------ | -------------------------- | ----------------------------------------------- | --------------------- | ---------------------------------------- |
| Block Kit `table` block                       | **Best**           | Low (Slack owns rendering) | 100×20 cap, plain-text cells, one table/message | Low–Med (~50–100 LOC) | **Primary**                              |
| `markdown` block (if it auto-converts tables) | Best               | Lowest                     | Empirically unverified for tables               | Trivial               | Spike in PR 1; fallback to `table` block |
| CSV file upload                               | Good               | Low                        | Adds `files:write` scope; new code path         | Medium                | **Secondary** (oversize tables)          |
| Canvas                                        | Best for long-form | Low                        | Different surface; free-tier needs channel_id   | Medium                | **Deferred**                             |
| Monospace padding fix                         | Mediocre           | Very low                   | Wide cols wrap, emojis misalign                 | Trivial               | **Drop**                                 |
| PNG render                                    | Bad a11y           | High infra                 | Copy-paste pain                                 | High                  | **No**                                   |

**Best per use case:**

- Small tables (≤20 cols, ≤100 rows): Block Kit `table` block.
- Wide/long tables: CSV upload.
- Documents (multiple tables, long-form): Canvas (later).

## Phase 3 — Current code audit

| Concern                 | Location                                                                                      | State                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Table wrapper           | `packages/core/src/gateway/connectors/slack.ts:102-142` `wrapTablesInCodeBlocks()`            | Detects GFM tables, wraps in ` ``` `                                                                         |
| Outbound entry          | `apps/agor-daemon/src/services/gateway.ts:853` `routeMessage()` → `connector.formatMessage()` | Plain mrkdwn text only                                                                                       |
| GitHub buffer           | `apps/agor-daemon/src/services/gateway.ts:908` `flushGitHubBuffer()`                          | Same path                                                                                                    |
| `chat.postMessage` call | `slack.ts:436-442`                                                                            | Text-only; **no `blocks` field**                                                                             |
| File upload code        | —                                                                                             | **None** — `files.uploadV2`, `files:write` would be net-new                                                  |
| Block Kit usage         | —                                                                                             | **None** — gateway is pure text/mrkdwn today                                                                 |
| OAuth scopes            | `slack.ts:201` (token construction)                                                           | No scope list in code; depends on admin's Slack app config. Min: `chat:write`. CSV path needs `files:write`. |
| Tests                   | `slack.test.ts` (55+ cases)                                                                   | Cover code-block wrap; small tables (3–4 cols × 3–4 rows)                                                    |

**Migration shape:** `formatMessage()` returns a string today. PR 1 changes it to `{ text: string; blocks?: Block[] }`, and `routeMessage` passes blocks through to `chat.postMessage`. The detector logic in `wrapTablesInCodeBlocks` is reused — same regex, same line-by-line state machine, different output: parse rows out, emit a `table` block instead of wrapping in backticks.

## Phase 4 — Recommendation (committed)

**Use Block Kit's native `table` block.** Drop the monospace fallback. Add CSV upload for oversize.

This is the right call because:

1. Slack shipped the rendering surface we wanted last time we looked. Use it.
2. The adapter is a small JSON emitter, not a library. ~50–100 LOC including types and tests. The detector already exists.
3. No new scopes. No new infrastructure. Same `chat:write` token, same `chat.postMessage` endpoint, with `blocks` populated.
4. Falls back gracefully to monospace for tables we can't fit (>20 cols) until PR 2 lands CSV.
5. Spike the `markdown` block first — if Slack auto-renders GFM tables inside it, we have an even simpler path (5 LOC: wrap content, send).

## Phase 5 — PR plan

### PR 1: `feat(gateway/slack): render markdown tables as Block Kit table blocks`

Scope:

- Spike: send a `markdown` block containing a GFM table to a test workspace. If Slack renders it as a native table, the change is "swap `formatMessage()` to return blocks: [{type: 'markdown', text: mrkdwn}]". Done.
- If not: write `markdownTableToTableBlock(tableLines: string[]): TableBlock` (~40 LOC). Replace the body of `flushTable()` in `wrapTablesInCodeBlocks` so it emits a structured block alongside the text instead of inline backticks.
- Change `formatMessage()` to return `{ text: string; blocks?: KnownBlock[] }`. Update `routeMessage()` and `flushGitHubBuffer()` callers and the `chat.postMessage` invocation at `slack.ts:436-442`.
- Tests: existing 55-case suite gets a parallel `expect(blocks)` axis. Add: empty table, single-row, max-width (20 col), over-cap (21 col → fallback to monospace), mixed text + table + text.
- **Fallback rule** (kept for safety): if rows > 100 OR cols > 20, fall back to the current monospace code-block path. Leave `wrapTablesInCodeBlocks` exported but unused in the happy path — keeps the deprecation surgical.

Out of scope:

- Rich-text cells (links/bold inside cells). Plain `raw_text` only in v1.
- Multiple tables per message — Slack caps at one. If a message has two, render the first as `table` block and the rest as monospace, OR emit two messages. **Recommend:** monospace fallback for tables 2..N to keep ordering intact.

Risk: the message-blocks payload size limit (~3000 chars per block) is tighter than mrkdwn's. Pre-flight check; fall back to monospace if exceeded.

### PR 2: `feat(gateway/slack): upload oversize tables as CSV attachments`

Scope:

- New helper `uploadTableAsCSV(channel: string, rows: string[][], filename: string)` using `web.files.uploadV2`.
- Trigger: PR 1's "over-cap fallback" path becomes a CSV upload instead of monospace, when rows > 100 OR cols > 20.
- Add a one-line message: "Table attached as CSV — preview/sort below."
- Hard caps: refuse uploads > 10k rows or > 5 MB.
- New scope: `files:write`. Document in `apps/agor-docs/pages/guide/` and in the gateway-channel onboarding.
- Tests: small synthetic table → uploaded; oversize → caps trigger; auth failure → graceful error to channel.

### PR 3 (deferred): Canvas attachment for long-form / multi-table outputs

Don't ship yet. Spec only if we get a user request. Free-tier caveat (`channel_id` required) limits the audience.

## Hard rules check

- ❌ No markdown-table-parser library inside agor — confirmed; the adapter is `split('|').map(trim)` plus a separator-row drop. Detector reuses the existing GFM regex.
- ❌ No PNG rendering — rejected.
- ❌ No code shipped from this worktree — confirmed.
- ✅ Concrete recommendation with cited Slack docs — Block Kit `table` block, native since Aug 2025.
- ✅ CSV path given a fair hearing — chosen for the oversize case, not the common case.

## Sources

- [Slack Developer Docs — Table block](https://docs.slack.dev/reference/block-kit/blocks/table-block/)
- [Slack Developer Docs — Markdown block](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/)
- [Slack Changelog — New supported markdown types for rich text (Mar 2026)](https://docs.slack.dev/changelog/2026/03/06/block-kit-rich-text/)
- [Slack Changelog — files.upload retirement (2024/2025)](https://docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay/)
- [Slack Developer Docs — canvases.create](https://docs.slack.dev/reference/methods/canvases.create/)
