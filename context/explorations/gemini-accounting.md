# Gemini Token & Context Accounting

**Goal:** give Gemini sessions feature parity with Claude Code and Codex for token tracking, cost estimates, and context-window pills so Agor shows accurate usage per task and per session.

---

## 0. Scope

- **Token pill (per task):** display input, output, total tokens + `$` estimate.
- **Context pill (per session/task):** show cumulative context usage vs. model limit.
- Reuse existing UX/components; focus on backend plumbing inside Gemini tool + daemon (UI already consumes the same fields).

---

## 1. Current State

| Area                | Status                                                                             | Source                                                       |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| SDK usage data      | ✅ `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`) | `node_modules/@google/gemini-cli-core/dist/src/core/turn.js` |
| Prompt service      | ❌ Drops `usageMetadata`; streaming events don't include it                        | `packages/core/src/tools/gemini/prompt-service.ts`           |
| Tool result payload | ❌ `GeminiTool.executePrompt*` never returns `tokenUsage`, `contextWindow`, etc.   | `packages/core/src/tools/gemini/gemini-tool.ts`              |
| Task completion     | ✅ daemon auto-computes cost/context when `tokenUsage` present                     | `apps/agor-daemon/src/index.ts:1910-2045`                    |
| Context utilities   | ✅ already support Gemini once tasks store `usage` + `context_window_limit`        | `packages/core/src/utils/context-window.ts`                  |
| Pricing data        | ✅ cost helper handles `gemini`                                                    | `packages/core/src/utils/pricing.ts`                         |

**Implication:** same as Codex—once Gemini tool returns proper usage metadata, downstream logic “just works.”

---

## 2. Implementation Plan

### Step 1 – Capture SDK usage

1. Extend `GeminiStreamEvent`/`GeminiPromptResult` with optional `usage: TokenUsage`.
2. In `promptSessionStreaming`:
   - When receiving a finished turn (`GeminiEventType.Finished`), read `event.value.usageMetadata`.
   - Map fields → Agor names:
     ```ts
     const usage = event.value?.usageMetadata
       ? {
           input_tokens: event.value.usageMetadata.promptTokenCount,
           output_tokens: event.value.usageMetadata.candidatesTokenCount,
           total_tokens: event.value.usageMetadata.totalTokenCount,
         }
       : undefined;
     ```
   - Include the latest `usage` in the yielded `complete` event.
3. In `promptSession`, set `inputTokens/outputTokens` from that usage (or zero fallback) and return the full object.

### Step 2 – Surface usage in GeminiTool

1. Add local `tokenUsage`, `contextWindow`, `contextWindowLimit` trackers inside both `executePromptWithStreaming` and `executePrompt`.
2. As you iterate events:
   - When hitting `complete`, grab `event.usage`.
   - Set `tokenUsage = event.usage`.
   - Compute context usage = `input_tokens` (Gemini has no cache-read concept).
   - Determine limit from resolved model (see Step 3).
3. When creating assistant messages, populate `message.metadata.tokens.input/output` with the captured numbers.
4. Include `tokenUsage`, `contextWindow`, `contextWindowLimit`, and `model` in the object returned to the daemon (mirrors Claude/Codex).

### Step 3 – Model limits

1. Define per-model limits in `packages/core/src/tools/gemini/models.ts` (values already listed but expose helper similar to `getCodexContextWindowLimit`).
2. When resolving model name, look up the limit; default to 1M if unknown (Gemini 2.0 Max) per Google docs.

### Step 4 – Task completion

- No daemon change needed: once `tokenUsage` is present in the result, `apps/agor-daemon/src/index.ts` will:
  - call `calculateTokenCost` → `usage.estimated_cost_usd`
  - set `context_window` and `context_window_limit`
  - recompute session-level context via `getSessionContextUsage()`

### Step 5 – Testing

1. Add unit tests around the new usage-mapping helper (mock a `usageMetadata` payload and assert the output).
2. Consider integration test for `GeminiTool.executePrompt` with mocked prompt service to ensure `tokenUsage` bubbles up.
3. Manual sanity check: run a Gemini session, watch logs for `📊 Session context: …`, verify UI pills update.

---

## 3. Data Flow Summary

1. **Gemini SDK** emits `usageMetadata` on `GeminiEventType.Finished`.
2. **GeminiPromptService** maps to Agor token object and yields it.
3. **GeminiTool** captures usage, writes token counts into message metadata, and returns usage + limits to daemon.
4. **Daemon** patches `tasks.usage`, `tasks.context_window`, `sessions.current_context_usage`, and `tasks.usage.estimated_cost_usd`.
5. **UI** (already wired) shows token & context pills per task/session.

---

## 4. Follow-ups / Nice-to-haves

- Detect `MAX_TOKENS` stop reasons from Gemini events and surface them in UI notifications.
- Persist raw `usageMetadata` for debugging (e.g., candidate-level breakdown if Google adds it).
- Surface usage in websockets for real-time dashboards (same as Claude/Codex roadmap).

---

## 5. Ownership Checklist

- [ ] Map `usageMetadata` → Agor `TokenUsage`.
- [ ] Return `tokenUsage` + limits from Gemini tool.
- [ ] Populate assistant message metadata tokens.
- [ ] Add `getGeminiContextWindowLimit`.
- [ ] Tests + manual validation.

Once complete, Gemini tokens/context behave identically to Claude Code and Codex without UI changes. Share this doc with whoever takes the task so they can execute immediately.
