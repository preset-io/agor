# Constants / No Magic Strings

**A string literal that is compared, emitted/listened for, or used as an identity key in 2+ places is a named export — declared once, colocated with its domain, never retyped at the call site.**

Applies to: event names, config key paths, channel/room prefixes, permission tiers, service paths, metadata keys — any literal whose _value_ carries meaning across files. It does **not** apply to log/UI copy or one-off literals used in a single place.

> This is the runtime-string companion to the "Centralize types" rule (`AGENTS.md`). That rule covers TypeScript _types_; this one covers the _values_ compared and emitted at runtime. The canonical union already existed for streaming events (`StreamingEventType`) while three call sites still hand-retyped the same literals — a type alone doesn't stop drift.

---

## The rule in one line

If you're about to write the same string literal a second time, export it from one place and import it instead.

Prefer, in order:

1. A **literal-union type** _derived from_ an `as const` array — one declaration gives you both the runtime list and the compile-time type, and they can't drift.
2. An **`as const` array / object** when you only need the runtime values.
3. A **`const`** for a single shared literal.

---

## DON'T — retype the set at each call site

```ts
// register-services.ts — the events registered on the service
events: ['queued', 'streaming:start', 'streaming:chunk', 'streaming:end',
         'streaming:error', 'thinking:start', 'thinking:chunk', 'thinking:end', ...],

// gateway.ts — a second, independent copy as a union type
async handleMessageStreamingEvent(
  event: 'streaming:start' | 'streaming:chunk' | 'streaming:end' | 'streaming:error', …

// register-routes.ts — a third copy as an equality chain
data.event === 'streaming:start' || data.event === 'streaming:chunk' || …
```

Three copies of the same protocol. Add an event in one, forget the others, and streaming silently half-works.

## DO — one source of truth, derive everything else

```ts
// packages/core/src/types/message.ts — colocated with the messages domain
export const MESSAGE_STREAM_LIFECYCLE_EVENTS = [
  'streaming:start',
  'streaming:chunk',
  'streaming:end',
  'streaming:error',
] as const;
export type MessageStreamLifecycleEvent = (typeof MESSAGE_STREAM_LIFECYCLE_EVENTS)[number];

export const STREAMING_EVENT_TYPES = [
  ...MESSAGE_STREAM_LIFECYCLE_EVENTS,
  'thinking:start',
  'thinking:chunk',
  'thinking:end',
] as const;
export type StreamingEventType = (typeof STREAMING_EVENT_TYPES)[number];
```

```ts
// register-services.ts        events: ['queued', ...STREAMING_EVENT_TYPES, 'permission_resolved'],
// gateway.ts                  event: MessageStreamLifecycleEvent
// register-routes.ts          (MESSAGE_STREAM_LIFECYCLE_EVENTS as readonly StreamingEventType[]).includes(data.event)
// realtime-publish.ts         const MESSAGE_STREAMING_EVENTS = new Set(STREAMING_EVENT_TYPES)
```

A single-literal comparison against an already-typed value — `if (event === 'streaming:chunk')` — is fine. The rule targets re-declaring the _set_, not every mention of a member.

---

## Where the constant lives

Colocate with the domain that owns the value, next to its type:

- **Has a canonical type already?** Put the runtime array beside it and derive the type from the array (as above). Streaming events live in `packages/core/src/types/message.ts`; task events in `apps/agor-daemon/src/services/tasks-events.ts`.
- **Daemon-only, no core type?** A small `*-events.ts` / `*-keys.ts` beside the service (e.g. the `MESSAGE_STREAMING_EVENTS` / `TASK_STREAMING_EVENTS` sets in `apps/agor-daemon/src/utils/realtime-publish.ts`).
- **Shared across packages?** It belongs in `packages/core` so every consumer imports the same identity.

Don't stash shared constants in whichever file happened to need them first — put them where the next reader would look for the domain.

---

## Enforcement

Regression is guarded for the streaming-event case by `scripts/check-magic-string-drift.mjs` (wired into `pnpm check` as `check:magic-string-drift`). It fails CI if those event names are re-listed as a union / array / `Set` / equality chain outside the shared constant. It is **not** a general-purpose linter — extend it (or the guard's scope) when you centralize the next family of literals. Per-line escape hatch: `// magic-string-guard:ignore <reason>`.
