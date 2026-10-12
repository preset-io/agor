# Frontend state and memory

How the browser client holds data, what survives a reload, what writes each store, and what
bounds it. `UI` = `apps/agor-ui/src`, `client` = `packages/client/src`,
`core` = `packages/core/src`. Line numbers are as of `85d7ce81` and counts as of `97eafaca`; code
wins when they drift.

Entity retention (scopes, coverage, pins, the partition LRU, reconnect resync) is specified in
[`user-first-scoped-hydration.md`](user-first-scoped-hydration.md). This doc links there instead
of repeating it. Everything here is a static reading of the code. Nothing is a heap measurement
unless stated. A claim not verifiable statically is marked **unverified**.

## Layers

```
socket.io + Feathers client   core/api/index.ts:1666-1722 (createClient)
└─ @agor-live/client          client/index.ts (core client + reactive sessions)
   ├─ useAgorClient           UI/hooks/useAgorClient.ts, called once at UI/App.tsx:350
   ├─ useAgorData             UI/hooks/useAgorData.ts, called once at UI/App.tsx:460:
   │  │                       first paint, background hydration, realtime wiring, resync
   │  └─ agorStore (zustand)  UI/store/agorStore.ts:276 → selectors (UI/store/selectors.ts)
   ├─ ReactiveSessionHandle   client/reactive-session.ts:255
   │                          (consumed through UI/hooks/useSharedReactiveSession.ts)
   └─ useServerRead           UI/hooks/useServerRead.ts: on-demand display data, per mounted key
```

- The only state libraries are zustand and immer (`apps/agor-ui/package.json:52,67`). There is
  no React Query, SWR, Redux, Jotai or MobX. immer drafts are used only for the branch cascades
  (`UI/store/agorStore.ts:436-527`).
- **Two sources of truth, by design.** The store holds entity summaries. Transcripts (tasks,
  messages, streams, tools) live only in reactive-session handles and never enter the store.
- The open session exists in up to three copies:
  - the store row, which may be lean (`UI/store/agorMaps.ts:34-41`);
  - the handle's full record;
  - a `useFullSessionDetails` snapshot (`UI/hooks/useFullSessionDetails.ts:1-19`).

  `SessionPanel` prefers the handle's copy (`UI/components/SessionPanel/SessionPanel.tsx:853-858`).

## Inventory

### Entity store (`UI/store/agorStore.ts:276`, one module singleton)

| Slice                                                        | Key              | Holds                                                                                    | Class                                                 |
| ------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `sessionById`, `sessionsByBranch`                            | session / branch | Lean list row or full record, last writer wins (`agorMaps.ts:34-43`)                     | Scoped (hydration doc)                                |
| `branchById`, `boardObjectById/ByBoardId`, `cardById`        | id / board       | Rows held by a scope (user scope, loaded partition) or a pin                             | Scoped (hydration doc)                                |
| `boardById`                                                  | board            | Every visible board (lean), full record for loaded partitions (`useAgorData.ts:744-746`) | Global, workspace-sized                               |
| `commentById`                                                | comment          | **Every** visible board comment, resolved included (`useAgorData.ts:991-997`)            | Global, workspace-sized                               |
| `userById`, `repoById`, `cardTypeById`                       | id               | Complete lists (`useAgorData.ts:750-761`)                                                | Global, workspace-sized                               |
| `mcpServerById`, `gatewayChannelById`, `artifactById`        | id               | Complete lists. Artifacts carry metadata fields only (`useAgorData.ts:646-696`)          | Global, workspace-sized                               |
| `sessionMcpServerIds`, `sessionMcpLoaded`                    | session          | MCP links per session (`agorStore.ts:106`)                                               | Follows its session (`retention.ts:217-221`)          |
| `userAuthenticatedMcpServerIds`, `agenticToolSettingsByName` | id / tool        | Caller's OAuth state, tenant tool settings (`agorStore.ts:87`)                           | Global, small                                         |
| `coverage`, `absentBranchIds`, `missingLinkTargets`          | scope / id       | Load bookkeeping (`agorStore.ts:56-68, 94`)                                              | Bounded; absent marks pruned (`userScope.ts:429-434`) |
| `deletedMcpServerIds`                                        | server           | Deletion fence (`agorStore.ts:78`), added at `agorRealtimeActions.ts:444`                | Grows until reset (tiny)                              |

`findAll` follows every continuation page (`core/api/index.ts:1291` onward), so `$limit` on the
global reads does not cap them.

### Module-level state outside the store

| State                                                                                               | Key                                         | Lifecycle                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `touchedIds`, `liveRevisions` (`UI/store/agorHydration.ts:105,139`)                                 | collection → id                             | Stamps kept only while a partition load is in flight; dropped at `:217`                                                          |
| `pending`, `tombstones` (`UI/store/realtimeBatch.ts:66-67`)                                         | session                                     | Swapped out on every flush (`:197-198`); a hidden tab flushes on a timer (`:179-185`)                                            |
| Pin counts (`UI/store/rowPins.ts:15-18`)                                                            | session / branch                            | Ref-counted; deleted at zero (`:45`)                                                                                             |
| `boardUses`, `lastUsed`, `inflight`, `dirtyReloads` (`UI/store/boardPartitions.ts:137,140,240,266`) | use / board                                 | Released with the consumer (`:152`), pruned by the LRU (`:183-186`), deleted on settle (`:293`, `:439`)                          |
| `inflight` (`UI/store/sessionMcpLinks.ts:64`), `holds` (`UI/store/backgroundReads.ts:14`)           | load key                                    | Deleted on settle (`:155`; `:33`)                                                                                                |
| `ownActivityCache` (`UI/store/selectors.ts:199`)                                                    | one slot                                    | Replaced when its input maps change                                                                                              |
| `byClient[…].known` (`UI/utils/accessCache.ts:41`)                                                  | `branch:<id>`, `board:<id>`, `groups:<uid>` | Kept past `ACCESS_TTL_MS` by design for `peekAccess` (`:134`, `:161`); dropped on a failed re-read or a scope change (`:95-101`) |
| `recipeIds` (`UI/components/BranchCard/sharedCssVarScope.ts:28`)                                    | theme recipe                                | LRU of 64 (`:84-87`)                                                                                                             |
| `widgetComponents`, route loaders, `useEmojiAutocomplete` cache                                     | fixed                                       | Bounded by construction                                                                                                          |

No `@agor/core` module that the UI loads at runtime holds mutable module state. Internal state
in third-party dependencies (socket.io-client, Feathers) was not checked.

### Transcript layer (`client/reactive-session.ts`)

| State                                                                                                                    | Key                              | Lifecycle                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------- |
| `SHARED_REACTIVE_SESSIONS` (`:3026`)                                                                                     | `sessionId:mode:scope` (`:3037`) | Ref-counted; disposed at zero (`:3074-3100`)                                     |
| `CLIENT_STREAM_STATE.subs`, `roomWanters` (`:2804`)                                                                      | session / room                   | Deleted on last release (`:2916`, `:3002`); whole registry dropped at `:3006`    |
| `keyToCanonical` (`:2869-2871`)                                                                                          | any id form                      | **No per-entry delete**; dropped only with the whole registry                    |
| Handle state: `tasks`, `messagesByTask`, `toolsByTask`, `loadedTaskIds`, `streamingMessages`, `queuedTasks` (`:130-144`) | task / message                   | See [Transcript bounds](#transcript-bounds); emptied by `dispose()` (`:916-960`) |
| Detail retention: `recentDetailTaskIds`, `detailPins`, `detailTaskIds` (`:294-296`)                                      | task                             | 10 recent + pinned + latest + executing turns                                    |
| Message and task journals (`:268-279`)                                                                                   | fetch token                      | Pruned to the fetches in flight (`:804-812`, `:845-853`)                         |
| `retiredStreamTasks` (`:331`)                                                                                            | stream                           | Capped at 256 (`:43`, `:1083-1084`)                                              |
| `detailBytesOf` (`:47`)                                                                                                  | message object                   | `WeakMap`                                                                        |

The UI always uses `lean` mode (`UI/hooks/useSharedReactiveSession.ts:34`). The open session
uses the `session` scope, shared by `SessionPanel.tsx:565-573`, `ConversationView.tsx:276` and
the boot prefetch (`UI/store/openedTranscriptPrefetch.ts:30-32`). Board peeks use the `preview`
scope (`UI/components/BranchCard/SessionLatestTaskPeek.tsx:44-51`).

### Hook and component state that holds data

| State                                                                         | Lifecycle                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event stream (`UI/hooks/useEventStream.ts:38-39`)                             | Last 500 socket events with **full payloads** (`:116-120`). Only while the panel is open (`UI/components/App/App.tsx:813-816`); cleared on close (`:46-48`) |
| Presence (`UI/hooks/usePresence.ts:97-98`)                                    | Capped by `rememberBounded` (`:67-85`), expired by intervals (`:261-295`), cleared on disconnect (`:251-252`)                                               |
| `useServerRead` data (`UI/hooks/useServerRead.ts:45-60`)                      | One key per mounted hook. A `null` key drops it                                                                                                             |
| `useFullSessionDetails` (`UI/hooks/useFullSessionDetails.ts:17-19`)           | One record, forgotten when the surface closes                                                                                                               |
| `runningTaskIdsRef` (`UI/hooks/useTaskCompletionChime.ts:37`)                 | In-flight own tasks; cleared on effect cleanup                                                                                                              |
| Warning dedupe sets (`UI/components/SessionCanvas/SessionCanvas.tsx:895,971`) | Add-only while the canvas is mounted (no `key` at `UI/components/App/App.tsx:1473`)                                                                         |
| `commentRefs` (`UI/components/CommentsPanel/CommentsPanel.tsx:583,829-830`)   | Add-only while the panel is mounted                                                                                                                         |
| `useMessages` (`UI/hooks/useMessages.ts:46`)                                  | Unbounded `findAll` of a session's messages. **No caller**; only re-exported (`UI/hooks/index.ts:20`)                                                       |

## Persistence

- **Memory only:** the whole store, every reactive handle and all hook state. A reload refetches
  first paint, the user scope, the displayed partition and the opened transcript.
- **URL** (`UI/hooks/useUrlState.ts:118`):
  - board, session, branch focus and artifact focus (`/b/`, `/s/`, `/w/`, `/a/`, at
    `UI/App.tsx:2283-2298`);
  - the settings section (`UI/hooks/useSettingsRoute.ts:39-44`);
  - knowledge `?q` and `?mode` (`UI/pages/KnowledgePage.tsx:490-492`).

  Modals, the terminal and panel selections are React state and do not survive a reload.

- **localStorage:**
  - tokens (`UI/utils/tokenRefresh.ts:10-11`);
  - per-user preferences under `agor:user:<uid>:` (`UI/hooks/useUserLocalStorage.ts:5-6`), such as
    panel sizes and recent boards (capped at 10, `UI/hooks/useRecentBoards.ts:11,44`);
  - browser-global preferences (theme, panel collapse, session sort);
  - one composer draft, owner-checked (`UI/utils/promptDrafts.ts:10,55`).
- **sessionStorage:** the prompt draft seed (`UI/utils/promptDrafts.ts:11`, 10-minute TTL) and the
  stale-chunk reload marker (`UI/components/ErrorBoundary/staleChunkReload.ts:7`).
- No IndexedDB, Cache API, cookies or service worker.
- **Logout:**
  - In memory, it clears the maps (`UI/hooks/useAgorData.ts:1248-1259`), cancels hydrations and
    releases the prefetch.
  - In storage, it clears only the tokens and the draft seed (`UI/hooks/useAuth.ts:994,1017`;
    `UI/utils/tokenRefresh.ts:94-97`). Browser-global keys, including the per-entity keys below,
    pass to the next user of the browser.
  - `UI/utils/authHeaders.ts:5` still falls back to a `feathers-jwt` key that current code never
    writes or clears. Whether old browsers still hold one is **unverified**.

Per-entity localStorage keys never removed:

| Key                                              | Defined                                                | Grows per                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `agor:branch-card:peeked-session-ids:<branchId>` | `UI/components/BranchCard/BranchCard.tsx:45,205-208`   | Branch ever peeked; emptied lists stay as `[]`                                                                         |
| `agor-mcp-banner-dismissed:<sessionId>`          | `UI/components/SessionPanel/SessionFooter.tsx:239-242` | Session whose MCP notice was dismissed                                                                                 |
| `agor:board:collapsed-branch-nodes` (one map)    | `UI/utils/collapsedBranchNodes.ts:21`                  | Branch with collapse exceptions. Pruned only on a hard-delete event a tab sees (`UI/store/agorRealtimeActions.ts:385`) |

`agor:currentBoardId` is written (`UI/components/App/App.tsx:692`) but never read.

## Writers

**Store writes** come from:

- `useAgorData`:
  - first paint and reconnect resync (`fetchData`; the resync trigger is at `:1750`);
  - background hydration (`:549-696`);
  - realtime handlers (`:1543-1683`).
- The loaders: `userScope.ts`, `boardPartitions.ts`, `idReads.ts`, `sessionMcpLinks.ts`.
- Eviction (`retention.ts:69`).
- One direct component call: `mcpServerRemoved` after a delete
  (`UI/components/Marketplace/MyServersTab.tsx:959`).

The entity store takes no optimistic writes. Optimistic UI is component state:

- canvas positions (`SessionCanvas.tsx:850,1021`);
- zone deletes (`UI/components/SessionCanvas/canvas/useBoardObjects.ts:211-231`);
- MCP tool overrides (`UI/components/Marketplace/MyServersTab.tsx:513`).

**Realtime:**

- Every entity collection wires `created`/`patched`/`removed` (`useAgorData.ts:1543-1683`).
- Every `removed` handler deletes its row. In `UI/store/agorRealtimeActions.ts`: `:212-240`,
  `:260-268`, `:283-288`, `:316-323`, `:364-386`, `:400-407`, `:425-447`, `:463-471`,
  `:498-506`, `:520-527`, `:554-562`, `:582-590`.
- Agentic tool settings wire only `created`/`patched` (`useAgorData.ts:1618-1619`). Whether the
  daemon ever removes such a row is **unverified**.
- Merge semantics:
  - **Whole-row replacement** with a shallow-equal bail-out (`agorMaps.ts:105-115`).
  - Sessions keep only their relationship projection fields (`agorMaps.ts:492-510`).
  - A lean row replaces a full one as is (`agorMaps.ts:34-41`).
  - A repo patch from an older clone generation is dropped (`agorRealtimeActions.ts:299-315`).
  - Session patches coalesce to one per session per frame, latest wins
    (`UI/store/realtimeBatch.ts:251`). Dropping the earlier patches is safe because realtime events
    carry full records (`agorMaps.ts:34-36`).
- **Admission:** a realtime write inserts a session, branch, board object or card only if a scope
  or pin holds it (`retention.ts:180-214`). Every other collection inserts on any `created`
  event.

**Transcript handles** register 23 listeners each. They cover the socket, sessions, tasks and
messages (`client/reactive-session.ts:2022-2025, 2060-2065, 2133-2143, 2186-2193, 2470-2524`).
Each handler drops events for other sessions (`matchesSession`, `:451`), and `dispose()` removes
every listener (`:924`).

**Gap: `removed` for a session misses remote surrogates.**

- `sessionRemoved` filters only the session's own branch bucket, by id
  (`agorRealtimeActions.ts:225-232`).
- A remote-create surrogate of that session lives under the creator's branch
  (`agorMaps.ts:521-523`). Surrogates the session created live in its own bucket under other ids.
- Archive (`agorMaps.ts:279-292`) and branch hard delete (`agorStore.ts:483-497`) both strip
  surrogates through `isSessionRowRemovedWith`. The direct path does not.
- Hard delete is reachable from `UI/hooks/useSessionActions.ts:260`.
- Only the cascade path is tested (`UI/store/agorStore.test.ts:194`). The stale surrogate lasts
  until the next rebuild of that bucket. This was found by reading the code and not reproduced.

## Lifecycle and growth

| Class            | Store                                                                                                                          | Bound or trigger                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded          | Board partitions                                                                                                               | Displayed board + 3 LRU; mounted or loading boards are never evicted (`UI/store/boardPartitions.ts:129,172-199`)                                           |
| Bounded          | User scope                                                                                                                     | 200 gated, 10,000 sessions, 1,000 teammates ([caps](user-first-scoped-hydration.md#caps))                                                                  |
| Bounded          | Transcript detail (tool payloads, reasoning)                                                                                   | 10 turns + protected turns, 32 MiB of strings (`client/reactive-session.ts:24,39,589-648`). Protected turns count against the budget but are never evicted |
| Bounded          | Lean transcript, display order, reader at bottom                                                                               | 30 turns (`:31`), trimmed from `UI/components/ConversationView/ConversationView.tsx:471-492`                                                               |
| Bounded          | Peek handles (`preview`)                                                                                                       | Latest + executing turns (`client/reactive-session.ts:1129-1146`)                                                                                          |
| Bounded          | Event stream, presence, realtime batch, journals, retired streams, recent boards, zone colors                                  | See the tables above                                                                                                                                       |
| Cleared-on-X     | All entity maps                                                                                                                | Mount (`useAgorData.ts:411`), identity change (`:1205`), logout (`:1256`)                                                                                  |
| Cleared-on-X     | Scoped rows                                                                                                                    | Pin release, LRU eviction, end of resync (`UI/store/retention.ts:1-17`)                                                                                    |
| Cleared-on-X     | Reactive handle                                                                                                                | Last consumer unmounts (`UI/hooks/useSharedReactiveSession.ts:69-73`). Boot prefetch: within 10 s + 30 s grace (`openedTranscriptPrefetch.ts:34-35,80-83`) |
| Cleared-on-X     | Session MCP links, `useServerRead`, `useFullSessionDetails`                                                                    | With their session, key or surface                                                                                                                         |
| **Unbounded**    | Global collections (comments, users, repos, boards, card types, MCP servers, gateway channels, artifacts)                      | Workspace size; `created` events add rows for the tab's lifetime. Removals are applied                                                                     |
| **Unbounded**    | `tasks: TaskID[]` on every session row                                                                                         | Total turns across loaded sessions. Lean rows keep it (`core/types/session.ts:348,854-875`; `core/db/repositories/sessions.ts:228`)                        |
| **Unbounded**    | Lean transcript that cannot trim                                                                                               | Turns loaded × time open. See [Transcript bounds](#transcript-bounds)                                                                                      |
| Unbounded, small | `keyToCanonical`, `accessCache.known`, `deletedMcpServerIds`, canvas warning sets, `commentRefs`, per-entity localStorage keys | Distinct sessions, branches or boards touched until each one's clear point (see the inventory)                                                             |

### Transcript bounds

- A trim runs only when all of these hold (`ConversationView.tsx:471-492`):
  - the reader is at the bottom with the stick-to-bottom lock engaged;
  - no older page is loading;
  - the handle follows display order (`client/reactive-session.ts:1328-1340, 1359-1365`).
- A reader scrolled up keeps every turn loaded since. This is by design: history stays while it
  is being read.
- **Legacy order never trims.** A session the daemon does not report as `tasks_complete`
  (`core/types/session.ts:245-250`) is read in task-ID order
  (`client/reactive-session.ts:1669,1811`). So are sessions whose task list stopped extending
  (`:1375-1386`). `trimOlderTasks` refuses both.
- Detail is still bounded in both cases. Lean history keeps text blocks; it drops tool and
  thinking blocks (`core/types/message.ts:359,366-407`).
- Whether trimming happens in a hidden tab depends on stick-to-bottom state there. **Unverified.**

### What scales with what

- **Session length:**
  - the lean transcript when it cannot trim;
  - the `tasks` array on every session row, re-sent in full with each session patch;
  - lean text of the 30-turn window. That is a turn count, not a byte bound.
- **Board size:** the displayed partition plus up to three background partitions (branches,
  sessions, board objects, cards), and their canvas nodes. Each peek adds a handle with
  23 listeners that filter every message, task and session event.
- **Workspace size:** the global collections, comments in particular.
- **Tab lifetime:** global `created` events, the small unbounded maps, and localStorage keys
  (which also outlive the tab).

## Known limitations

Current behavior, by design or not yet addressed:

- The lean transcript does not trim while the reader is scrolled up or an older page is loading
  (`UI/components/ConversationView/ConversationView.tsx:471-492`), nor when the handle reads in
  task-ID order (`client/reactive-session.ts:1333,1362-1368`). Its text grows with every turn
  loaded while the session stays open.
- Global collections (comments, users, repos, boards, card types, MCP servers, gateway channels,
  artifacts) are never evicted. Eviction covers only branches, sessions, board objects and cards
  (`UI/store/retention.ts:195-211`). Global rows leave only on a `removed` event or a full clear.
- Every session row, lean rows included, carries its full `tasks: TaskID[]` list
  (`core/types/session.ts:348`; `core/db/repositories/sessions.ts:228`).
- Logout clears only the tokens and the draft seed (`UI/hooks/useAuth.ts:994,1017`;
  `UI/utils/tokenRefresh.ts:94-97`). Per-branch peek keys and per-session MCP-banner keys stay in
  localStorage (`UI/components/BranchCard/BranchCard.tsx:45,205-208`;
  `UI/components/SessionPanel/SessionFooter.tsx:239-242`).

Follow-up work is tracked in [#3077](https://github.com/preset-io/agor/issues/3077).

## Listener hygiene

- 168 socket and Feathers registrations. 165 are removed with the same function reference. The
  other 3 are removed by `removeAllListeners()` when the client is torn down
  (`UI/hooks/useAgorClient.ts:475`). None are unmatched.
- Every `setInterval` is cleared and every observer disconnected.
- Feathers maps `service.on` to the socket event `"<path> <event>"`, so `client.service()`
  returning a new object does not break pairing.
- Traps rather than leaks:
  - `client.session()` returns an un-refcounted handle (`client/reactive-session.ts:2747-2749`).
    Use `retainReactiveSession`.
  - `realtimeBatch.ts:243-245` registers one module-level `visibilitychange` listener, on purpose.

## Broader architecture

- **Shells:**
  - `UI/App.tsx` holds the router, providers, auth, CRUD handlers and modals.
  - `UI/components/App/App.tsx` is the lazy desktop workspace.
  - `UI/components/mobile/MobileApp.tsx` is the phone shell.
- **Routing:**
  - `BrowserRouter` at `UI/App.tsx:2354`, routes at `:2197-2302`, lazy page loaders at
    `:176-241`.
  - `UI/surfaces/DeviceRouter.tsx:9` switches between the desktop and phone shells.
  - `StrictMode` is disabled (`UI/main.tsx:33-37`), so double-mount bugs in effects do not
    surface in development.
- **Providers:** memoized, except the theme value, an inline object
  (`UI/contexts/ThemeContext.tsx:142`).
- **Prop drilling and mixed ownership.** Counts exclude tests and marketing pages:
  - 62 `userById=` props and 199 `client={client}` props.
  - 80 whole-map `useAgorStore(select…)` subscriptions in 29 files, counting the 15 plain map
    selectors at `UI/store/selectors.ts:39-54`.
  - Some components both subscribe and drill, e.g. `AppHeader.tsx:180-182`.
  - `MobileApp.tsx:182-188` subscribes to 7 maps and passes them down.
  - Actions arrive both as props and through `AppActionsContext`
    (`UI/components/App/App.tsx:1150`).
- **Mixed sources:** `canSwitchTool` reads `tasks` from the store row while the panel renders
  tasks from the handle (`SessionPanel.tsx:980`).
