# Bounded Transcript Projection

**Status:** Approved — revision 2

**Issue:** #1900

**Date:** 2026-07-13

## Problem Statement

An executor persists transcript messages through acknowledged Socket.IO/Feathers service calls. Those writes are intentionally ordered and awaited so the stored transcript matches the agent's event order. Today, however, an acknowledgement can be lost or stranded without settling the caller's promise. Any executor service acknowledgement can encounter this transport failure; a transcript request that exceeds Socket.IO's packet ceiling is one independent, reproducible trigger.

When an awaited write never settles, the executor cannot persist later tool results or the final assistant response and cannot reach its normal terminal task patch. The task can remain visibly running with a spinner even though useful agent output already exists. Raising only an HTTP body limit does not address the Socket.IO ceiling, and truncating provider output at ingestion would couple persistence safety to individual SDKs while leaving other lost acknowledgements unbounded.

## Solution

Apply two independent safeguards at the shared executor client boundary:

1. Give every executor Socket.IO acknowledgement one finite 60-second deadline. Expose native `ackTimeout` through the generic core client, set it once when creating an executor client, and never enable Socket.IO acknowledgement retries. A missing acknowledgement must reject and enter existing task-failure convergence rather than leave the executor pending forever.
2. Before the executor sends transcript create or patch data, immutably project oversized canonical tool-result content into a bounded persisted preview. Keep requests at or below an executor-local 800,000-byte request-data budget, leaving headroom beneath the shared 1,000,000-byte transport ceiling. Preserve ordered, awaited persistence and all non-result semantics.

Users still see the useful head and tail of a projected result, a consistent notice that the stored transcript is incomplete, the original and persisted content sizes, error state, and any diff enrichment. Under-budget writes are unchanged. If eligible tool-result content cannot make the complete request fit, reject locally instead of risking a transport disconnect.

## User Stories

1. As a user running an agent, I want a large tool result to persist as a useful bounded preview, so that the remainder of the transcript can still be saved.
2. As a user reading a projected result, I want to see both its beginning and end, so that introductory context and terminal errors or summaries remain available.
3. As a user reading any tool-result presentation, I want one consistent truncation notice with size information, so that I do not mistake a preview for the complete result.
4. As a user debugging a failed tool, I want projection to preserve its error state and diff enrichment, so that the most actionable information is not discarded.
5. As a user waiting for a task, I want a lost service acknowledgement to finish as a visible terminal failure, so that the transcript does not show an indefinite spinner.
6. As a user whose transcript writes succeed, I want the final assistant response to persist after earlier tool results in the same order the agent produced them.
7. As an executor maintainer, I want one transport deadline for all executor service acknowledgements, so that a lost acknowledgement on a non-message control call cannot hang the process either.
8. As an executor maintainer, I want projection at the application-level client hook seam, so that single creates, patches, and bulk creates share one provider-independent policy.
9. As an executor maintainer, I want under-budget requests to pass through by identity and oversized requests to be projected without mutating caller data, so that existing handler assumptions and concurrent writes remain safe.
10. As an operator, I want ambiguous acknowledged writes never to retry automatically, so that a committed write whose acknowledgement was lost is not duplicated.
11. As an operator, I want an irreducibly large transcript request rejected before transmission with a bounded diagnostic, so that the socket remains usable and the task can converge through existing failure handling.
12. As a UI maintainer, I want a canonical tool-result block and projection metadata contract, so that generic, custom, and standalone Task-result renderers cannot drift.

## Implementation Decisions

### Transport contract

- Core owns a single exported Socket.IO transport ceiling of **1,000,000 bytes**. The daemon's Socket.IO server consumes that constant rather than repeating a literal.
- The generic core client accepts an optional native Socket.IO `ackTimeout` and forwards it unchanged to Socket.IO. It does not set a default and does not expose or enable acknowledgement retries as part of this work.
- Executor client creation supplies an executor-local **60,000 ms** acknowledgement timeout once for the whole connection. It therefore applies to transcript persistence, task/session control calls, authentication-related acknowledgements, and `/messages/streaming` alike.
- Current executor service calls do not justify a longer initial deadline: long-running SDK, git, environment, and permission-wait work happens in the executor or in separate process lifecycles; the associated daemon calls are authentication, lookup, metadata mutation, or event relay acknowledgements. Sixty seconds is intentionally generous relative to those calls. Changing it later requires evidence of a legitimate daemon acknowledgement that needs longer.
- Socket reconnection remains enabled, but acknowledgement retries remain disabled. A timeout means the call outcome is ambiguous: the daemon may have committed the mutation before the acknowledgement was lost. Retrying would risk duplicate messages and events.
- The timeout bounds a single acknowledgement; it does not alter Socket.IO connection establishment or reconnection timing.

### Canonical message result and projection contract

- Core defines and exports a canonical `ToolResultContentBlock` instead of having UI and executor modules redefine the shape. It includes the `tool_result` discriminator, `tool_use_id`, content, optional `is_error`, optional diff enrichment, optional provider metadata, and unknown outer fields for compatible transcript data.
- Core also defines a `TranscriptContentProjection` record attached to a projected tool-result block as `transcript_projection`. It has exactly these required fields:
  - `truncated: true`
  - `original_content_bytes: number`
  - `persisted_content_bytes: number`
- `transcript_projection` is a sibling of existing block metadata. Projection must not overwrite or merge into a provider's `metadata` field.
- Content byte counts use UTF-8 bytes of the string itself for string content and UTF-8 bytes of compact JSON serialization for structured content. `persisted_content_bytes` is measured again from the final persisted content; it is not estimated from a requested slice size.
- Existing unprojected records remain valid because projection metadata is optional. No database schema or migration is required.

### Bounded request projector

- The executor owns the **800,000-byte** request-data budget and the projector implementation. Neither becomes configuration or a core policy.
- The projector is a pure, synchronous, provider-independent function over Feathers request data. It measures UTF-8 bytes of the complete compact JSON serialization that will be passed as `context.data`, not merely the visible tool output.
- If complete request data is within budget, the projector returns the original reference and adds no metadata.
- If request data is over budget, the projector finds only canonical tool-result blocks inside message content. It supports a single message object, a partial message patch, and an array used by bulk create. Other paths and other content blocks are never candidates.
- Candidates are ordered by descending original content bytes, with encounter order as the deterministic tie-breaker. The projector reduces the largest result first, remeasuring the complete request after every replacement. It stops as soon as the request fits.
- Projection uses copy-on-write cloning. The input object, its arrays, content blocks, structured tool-result content, diff enrichment, metadata, and unrelated nested values remain unchanged. The function holds no cross-call state, so concurrent projections cannot influence one another.
- String content becomes a UTF-8-safe head/marker/tail preview. Head and tail receive approximately equal remaining byte budgets after the marker. Slicing must occur on decoded code-point boundaries and must never introduce a replacement character, broken surrogate, or invalid UTF-8.
- The marker is deterministic and states that the middle was omitted from transcript storage. It contains no provider-specific wording and is included in `persisted_content_bytes`.
- Structured or array content may be compactly JSON-serialized and replaced by a bounded textual head/marker/tail preview. The replacement is a valid string member of the canonical tool-result content union; the projector does not emit malformed partial JSON or invent synthetic structured blocks.
- The outer tool-result block is copied with every existing field preserved, including `tool_use_id`, `is_error`, `metadata`, diff enrichment, and unknown provider fields. Only `content` and `transcript_projection` change.
- The projector accounts for the bytes added by its marker and projection metadata. It may iteratively reduce a candidate down to the smallest useful marker-only representation.
- After processing candidates, it reserializes and remeasures the full request. If the request is still above 800,000 bytes, serialization is invalid, or no eligible tool-result can be reduced, it throws a local bounded error containing the measured request size, budget, service method, and path but none of the result content. No transport call is made.
- Projection does not change message indices, split writes, parallelize writes, or catch persistence errors. Existing provider handlers continue to await each persistence operation in their current event order.

### Executor client hook seam

- Register one existing-style application-level client hook during executor client creation. The hook filters exactly:
  - `messages.create`
  - `messages.patch`
  - `messages/bulk.create`
- For those operations, replace `context.data` with the projector's return value before continuing the original call. Do not wrap service methods individually and do not introduce provider-specific projection calls.
- `/messages/streaming` is deliberately outside projection because it carries transient event envelopes rather than canonical persisted messages. It still receives the executor-wide acknowledgement timeout.
- All other executor service calls receive only the timeout behavior.

### Failure convergence

- Implementation begins by proving the existing failure path before adding projection or UI work. Force a sub-limit service mutation to lose its acknowledgement across a disconnect/reconnect and observe the executor after the deadline.
- Successful convergence is either:
  1. the executor reconnects/re-authenticates and its existing terminal patch marks the task failed, or
  2. process shutdown plus the daemon's existing executor-exit safety net or stale-heartbeat supervisor marks the task failed and returns the session to a promptable state.
- The converged terminal record must retain a useful error message, and the UI must stop rendering the running spinner.
- If neither existing path converges in the test environment, stop this implementation and report a material ambiguity. Do not add a retry, durable queue, alternate write path, or new recovery state machine under this issue.

### UI presentation

- UI code consumes the canonical `ToolResultContentBlock` everywhere rather than maintaining local result interfaces.
- Provide one shared projection notice/formatter. Its user-facing meaning is: **Result truncated for transcript storage; showing the persisted content size out of the original content size.** Byte formatting is consistent and accessible, and the notice is absent without `transcript_projection`.
- `ToolUseRenderer` owns placement of the shared notice around both generic output and registered custom renderers. A custom renderer cannot accidentally hide the notice even when it renders only diff or status information.
- Standalone Task-result flows that bypass `ToolUseRenderer` reuse the same notice in both `MessageBlock` and `AgentChain`. The notice is rendered adjacent to the projected result, not concatenated into copied result text.
- Projection metadata does not change error styling, tool status, diff rendering, content copy behavior, or the existing collapsed/expanded behavior.

## Testing Decisions

Tests assert behavior at the highest existing seam that owns it and avoid asserting private helper steps. Pure byte projection receives focused unit coverage; hook routing, transport acknowledgement behavior, executor lifecycle convergence, provider persistence order, and rendered notices are covered at their respective public seams.

### Phase-zero transport and convergence proof

1. Use a real Socket.IO/Feathers test connection with a short test deadline to commit a **sub-limit** mutation and intentionally strand its acknowledgement while disconnecting the client. Allow reconnection and re-authentication, then assert that the original promise rejects within its deadline rather than hanging.
2. Assert the daemon observed the mutation at most once. Capture outbound events or service invocations to prove no acknowledgement retry was sent before or after reconnect.
3. Exercise the executor failure boundary from that rejection. Assert either the post-reconnect terminal patch or the existing daemon exit/heartbeat safety net changes the task to `failed`, makes the session promptable, records an error, and leaves the rendered task without a running spinner.
4. Treat failure of both convergence routes as the stop condition described above. This proof is required before projector implementation proceeds.

### Core client and transport ceiling

1. Extend the generic client tests to assert that an explicit `ackTimeout` reaches Socket.IO unchanged and omission leaves it unset.
2. Assert no `retries` option is introduced.
3. Assert daemon Socket.IO configuration uses the shared 1,000,000-byte ceiling.

### Projector and client hook

1. Pass a request just below or exactly at 800,000 bytes and assert reference-identical pass-through with no projection metadata.
2. Project an oversized Unicode string containing multi-byte emoji, combining characters, and non-Latin text. Assert the full request fits, head and tail survive, the marker is present, UTF-8 is valid, no replacement character appears, and byte metadata is exact.
3. Project oversized array/structured content. Assert it becomes a bounded textual preview, remains valid canonical tool-result content, and records exact original/persisted sizes.
4. Cover `messages.create`, `messages.patch`, and `messages/bulk.create` through the application hook with oversized data. Assert `/messages/streaming` and unrelated paths are byte-for-byte untouched by projection.
5. Put multiple differently sized results in one message and in one bulk request. Assert the largest content is reduced first and only as many results as necessary are changed. Cover equal-size deterministic ordering.
6. Run independent projections concurrently and assert deterministic outputs with no shared counters or state leakage.
7. Deep-freeze and snapshot the original inputs. Assert no nested input, including structured content, metadata, unknown fields, or diff hunks, is mutated.
8. Assert outer error state, provider metadata, unknown fields, and single- and multi-file diff enrichment survive projection exactly.
9. Build a request whose preserved non-result fields or diff data make it irreducibly oversized. Assert local rejection after final measurement and assert the underlying service transport is never invoked.
10. Cover serialization failure with the same local/no-send behavior and a diagnostic that does not echo content.

### Ordered persistence and terminal behavior

1. Feed a provider handler multiple/concurrent tool results followed by a final assistant response, using deferred service acknowledgements. Assert each ordered persistence call is awaited where the provider event order requires it and the final response is not sent early.
2. Resolve successful writes and assert every projected tool result plus the later final response persists in correct message-index order.
3. Reject an unrecoverable write and assert later transcript writes do not continue, the existing failure boundary receives the error, and the task reaches the terminal behavior proven in phase zero.
4. Keep bulk coverage distinct from single-write coverage so array projection and message ordering are both exercised.

### UI notices

1. Render a projected result through the generic tool renderer and assert the shared notice and exact formatted sizes are visible while the bounded content remains usable.
2. Render a projected result through a registered custom renderer and assert the identical notice remains visible alongside custom diff/error presentation.
3. Render standalone Task results through both `MessageBlock` and `AgentChain` paths and assert the identical notice appears once per projected result.
4. Render unprojected results through every notice path and assert no notice appears.
5. Assert error styling, tool status, diff presentation, and copyable result text remain intact, and that notice text is not injected into copied result content.
6. Render a task after unrecoverable persistence failure and assert terminal failure presentation replaces all running/pending spinners.

## Out of Scope

- Automatic Socket.IO acknowledgement retries or application-level mutation retries.
- A durable executor write queue, replay log, alternate persistence path, or new recovery state machine.
- Chunking one message across multiple service calls.
- Blob storage, attachment storage, or any mechanism for retrieving the discarded full result.
- Provider- or tool-specific truncation policy.
- Changing ordered, awaited transcript persistence.
- Truncating tool inputs, diff enrichment, ordinary assistant/user text, streaming event envelopes, or arbitrary oversized non-result fields.
- Raising the shared transport ceiling as the primary fix.
- User-configurable request budgets or acknowledgement deadlines without demonstrated operational need.
- Database schema changes or backfilling projection metadata onto historical messages.

## Further Notes

- The 800,000-byte request-data budget is intentionally lower than the 1,000,000-byte packet ceiling because Socket.IO and Feathers add event names, callback identifiers, and envelope bytes around `context.data`.
- Projection is a persistence representation, not a modification to the provider's live context or SDK transcript. The agent may have consumed the full result even though Agor stores only the bounded preview.
- There is no material design ambiguity in revision 2. The only implementation gate is empirical failure convergence: if both existing terminal routes fail under the required lost-ack test, implementation must stop and return that result rather than expanding scope.
