# Bounded Transcript Projection

**Status:** Approved
**Issue:** #1900

Executors persist ordered transcript events through acknowledged Socket.IO calls.
An oversized packet can disconnect before its acknowledgement arrives, while a
lost acknowledgement can strand even a small request. Raising the packet ceiling
therefore does not fix the indefinite wait, and retrying ambiguous writes could
duplicate transcript rows.

## Decision

Use two safeguards at the shared executor-client boundary:

1. Give executor acknowledgements a 60-second native deadline without retries.
2. Before message create, patch, or bulk-create calls, project request data above
   800,000 bytes into a bounded transcript preview.

The lower request-data budget leaves envelope headroom below the daemon's shared
1,000,000-byte Socket.IO ceiling. Projection reduces only canonical tool-result
content, largest first, into a UTF-8-safe head/marker/tail preview. It preserves
the outer result and records exact original and persisted content byte counts.

Projection changes only Agor's stored transcript after the agent has consumed the
complete result. Irreducible or unserializable data rejects locally, while lost
acknowledgements flow through the existing executor failure boundary. The UI
discloses projected results through one shared notice.

This intentionally does not add retries, chunking, alternate storage, queues,
provider-specific truncation, configuration, schema changes, or backfills.
