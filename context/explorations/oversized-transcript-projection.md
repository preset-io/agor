# Bounded Transcript Projection

**Status:** Approved — revision 2
**Issue:** #1900
**Date:** 2026-07-13

## Problem

Executors persist ordered transcript events through acknowledged Socket.IO
service calls. An oversized packet can disconnect the socket before its
acknowledgement arrives, and acknowledgements can also be lost for smaller
requests. Without a deadline, the awaited call can remain pending while the
agent and heartbeat loop continue, leaving the task visibly running forever.

Raising the packet ceiling alone does not protect against arbitrarily large
results or other lost acknowledgements. Retrying ambiguous writes could create
duplicate transcript rows.

## Decision

Use two independent safeguards at the shared executor-client boundary:

1. Give every executor Socket.IO acknowledgement a 60-second native deadline.
   Keep reconnection enabled, but do not enable acknowledgement retries.
2. Before `messages.create`, `messages.patch`, or `messages/bulk.create`, project
   request data larger than 800,000 bytes into a bounded persisted preview.
   Keep `/messages/streaming` and unrelated services unchanged.

The daemon continues to enforce its shared 1,000,000-byte Socket.IO packet
ceiling. The lower executor budget leaves room for Feathers and Socket.IO
envelopes.

## Projection contract

- Under-budget data passes through by identity.
- Only canonical `tool_result` content is eligible for projection.
- Candidates are reduced largest-first with deterministic encounter-order ties.
- String and structured content become a UTF-8-safe head/marker/tail string.
- The outer result keeps its tool id, error state, metadata, diff enrichment,
  and unknown provider fields.
- `transcript_projection` records `truncated: true` plus exact original and
  persisted content byte counts.
- Projection is synchronous, immutable, provider-independent, and stateless.
- Preview work never exceeds the complete request-data budget.
- Irreducible or unserializable data rejects locally with a bounded,
  content-free diagnostic before transport.

Projection changes only Agor's stored transcript. The agent has already consumed
the complete tool result.

## Failure and UI behavior

A lost acknowledgement rejects through the existing executor failure boundary.
The task becomes failed, the session becomes promptable, and the UI stops
showing a running tool. No recovery queue or alternate persistence path is
introduced.

Projected results retain useful head and tail content. Generic, custom, and
standalone transcript renderers show one shared notice with persisted and
original sizes; unprojected results are unchanged.

## Required evidence

- Native acknowledgement timeout with no retries and exactly one mutation.
- Disconnect, reconnect, reauthentication, and terminal task/session convergence.
- Projection above 1 MB, structured and Unicode content, bulk requests,
  deterministic multiple-result ordering, immutability, and local rejection.
- Ordered provider persistence through later tool events and the final response.
- UI notice, error/diff preservation, copy behavior, and terminal spinner removal.

## Out of scope

- Increasing the packet ceiling as the primary fix.
- Automatic write retries, durable queues, replay logs, or new recovery states.
- Chunking messages or storing the discarded full result elsewhere.
- Provider-specific truncation, arbitrary non-result truncation, configuration,
  schema changes, or historical backfills.
