import type { BranchDeletionRelationPolicy } from '../types/branch-deletion';

const owned = (reason: string): BranchDeletionRelationPolicy => ({
  disposition: 'delete_owned',
  reason,
});
const clear = (reason: string): BranchDeletionRelationPolicy => ({
  disposition: 'clear_reference',
  reason,
});
const classify = (reason: string): BranchDeletionRelationPolicy => ({
  disposition: 'classify',
  reason,
});
const retain = (reason: string): BranchDeletionRelationPolicy => ({
  disposition: 'retain',
  reason,
});

/** Exact physical table.column keys, including composite PostgreSQL FK subjects. */
export const BRANCH_DELETION_RELATIONS: Readonly<Record<string, BranchDeletionRelationPolicy>> = {
  'sessions.branch_id': owned('Branch membership, not genealogy, owns a session.'),
  'sessions.schedule_id': clear(
    'Preserve foreign-branch sessions; clear deleted schedule provenance.'
  ),
  'tasks.session_id': owned('Settle runtime containment before deleting tasks in bounded chunks.'),
  'messages.session_id': owned('Batch by session, including messages without a task.'),
  'messages.task_id': classify(
    'Delete branch-owned messages; a foreign-session reference is not ownership.'
  ),
  'schedules.branch_id': owned('Fence production before deleting schedules.'),
  'schedules.last_run_session_id': clear('Preserve schedules owned by other branches.'),
  'branch_owners.branch_id': owned('Retain all authorization rows until finalization.'),
  'branch_group_grants.branch_id': owned(
    'Retain compatibility authorization rows until finalization.'
  ),
  'branch_permission_configs.branch_id': owned(
    'Delete branch override only, never the board default.'
  ),
  'branch_permission_entries.config_id': owned(
    'Delete entries only for the owned branch configuration at finalization.'
  ),
  'boards.primary_teammate_id': clear('Board survives; never traverse upward into it.'),
  'boards.primary_assistant_id': clear('Clear the historical compatibility pointer too.'),
  'board_objects.branch_id': owned(
    'Remove the branch placement at finalization; retain board and cards.'
  ),
  'board_comments.branch_id': owned(
    'Branch-attached comments are owned; reconcile plain-ID reply links before deletion.'
  ),
  'board_comments.session_id': classify(
    'Preserve shared board discussion; clear attachments unless the comment is branch-owned.'
  ),
  'board_comments.task_id': classify(
    'Preserve shared board discussion; clear attachments unless the comment is branch-owned.'
  ),
  'board_comments.message_id': classify(
    'Preserve shared board discussion; clear attachments unless the comment is branch-owned.'
  ),
  'artifacts.branch_id': clear(
    'Published artifacts are board-owned; workspace staging disappears with the workspace.'
  ),
  'artifacts.source_session_id': clear(
    'Provenance is not exclusive ownership of a published artifact.'
  ),
  'session_relationships.source_session_id': owned(
    'Remove association only, never the opposite session.'
  ),
  'session_relationships.target_session_id': owned(
    'Remove association only, never the opposite session.'
  ),
  'session_relationships.callback_session_id': clear(
    'Disable callback and clear destination without deleting unrelated sessions.'
  ),
  'session_mcp_servers.session_id': owned(
    'Delete attachment, preserve shared server and OAuth grants.'
  ),
  'session_env_selections.session_id': owned(
    'Delete selection, preserve user-owned environment values.'
  ),
  'gateway_channels.target_branch_id': owned(
    'Quiesce listener and deliveries before removing channel-owned credentials.'
  ),
  'gateway_inbound_events.gateway_channel_id': owned(
    'Remove channel-owned idempotency and delivery records after quiescence.'
  ),
  'gateway_inbound_events.session_id': clear(
    'A foreign channel survives; clear session provenance.'
  ),
  'gateway_inbound_events.task_id': clear('A foreign channel survives; clear task provenance.'),
  'thread_session_map.channel_id': owned('Remove mappings belonging to the removed channel.'),
  'thread_session_map.session_id': owned(
    'Remove session associations, not external provider threads.'
  ),
  'thread_session_map.branch_id': owned('Restrictive FK must be drained before branch removal.'),
  'discord_message_deliveries.message_id': owned(
    'Quiesce delivery claims before deleting message descendants.'
  ),
  'discord_message_deliveries.gateway_channel_id': owned(
    'Quiesce delivery claims before deleting channel descendants.'
  ),
  'discord_message_deliveries.thread_session_map_id': owned(
    'Drain delivery children before thread mappings.'
  ),
  'gateway_outbound_messages.gateway_channel_id': owned(
    'Delete channel-owned local payloads, not external provider content.'
  ),
  'gateway_outbound_messages.target_branch_id': owned(
    'Drain restrictive branch reference before finalization.'
  ),
  'gateway_outbound_messages.emitted_by_session_id': clear(
    'Preserve foreign-channel outbound content; clear provenance.'
  ),
  'gateway_outbound_messages.emitted_by_task_id': clear(
    'Preserve foreign-channel outbound content; clear provenance.'
  ),
  'gateway_outbound_messages.emitted_by_schedule_id': clear(
    'Preserve foreign-channel outbound content; clear provenance.'
  ),
  'gateway_outbound_messages.consumed_by_session_id': clear(
    'Preserve foreign-channel outbound content; clear provenance.'
  ),
  'kb_namespaces.branch_id': classify(
    'Delete only kind=branch with proven exclusive ownership; preserve team/repo/user namespaces and clear the reference.'
  ),
  'kb_namespace_acl.namespace_id': owned(
    'Only ACLs of exclusively owned namespaces; retain authorization until content is gone.'
  ),
  'kb_documents.namespace_id': owned(
    'Only documents in exclusively owned namespaces; do not delete shared documents mentioning a branch.'
  ),
  'kb_document_versions.document_id': owned('Batch versions of owned documents, including blobs.'),
  'kb_document_units.document_id': owned(
    'Batch units of owned documents after settling embedding workers.'
  ),
  'kb_document_units.version_id': owned('Drain units before deleting owned versions.'),
  'kb_graph_nodes.namespace_id': owned(
    'Owned namespace graph projection; edges must be drained first.'
  ),
  'kb_graph_nodes.document_id': owned(
    'Owned document graph projection; preserve referenced shared documents.'
  ),
  'kb_graph_nodes.unit_id': owned('Owned unit graph projection.'),
  'kb_graph_nodes.branch_id': owned(
    'Branch graph projection, not the content of documents referencing it.'
  ),
  'kb_graph_nodes.session_id': owned('Deleted session graph projection.'),
  'kb_graph_nodes.task_id': owned('Deleted task graph projection.'),
  'kb_graph_nodes.message_id': owned('Deleted message graph projection.'),
  'kb_graph_edges.source_node_id': owned(
    'Remove edges incident to deleted nodes; preserve opposite nodes.'
  ),
  'kb_graph_edges.target_node_id': owned(
    'Remove edges incident to deleted nodes; preserve opposite nodes.'
  ),
};

/**
 * Ownership review contract, not an executable FK-cascade plan. Some rows in
 * these families are exclusively branch-owned, others are shared. Every inbound
 * FK into these families is pinned by the dual-schema audit test. Unknown
 * ownership must block finalization; this list never authorizes DML. Derive it
 * from owned/mixed relation sources so their descendants cannot silently fall
 * outside the audit when a new ownership classification is added.
 */
export const BRANCH_DELETION_RESOURCE_FAMILIES: readonly string[] = [
  'branches',
  ...new Set(
    Object.entries(BRANCH_DELETION_RELATIONS)
      .filter(([, policy]) => ['delete_owned', 'classify'].includes(policy.disposition))
      .map(([relation]) => relation.split('.')[0]!)
  ),
];

/** Plain IDs, JSON pointers and runtime/external resources missed by FK traversal. */
export const BRANCH_DELETION_NON_FK_RELATIONS: Readonly<
  Record<string, BranchDeletionRelationPolicy>
> = {
  'uploads.branch_id': owned(
    'Capture storage_key/version and verify bytes removed before deleting metadata.'
  ),
  'uploads.session_id': classify(
    'Must agree with branch ownership; conflicting bindings block deletion.'
  ),
  'executor_session_token_authorities.branch_id': classify(
    'Contain first; revoke and retain minimal tombstones only until existing authority expiry.'
  ),
  'executor_session_token_authorities.session_id': classify(
    'Include authorities without branch_id, using owned session inventory.'
  ),
  'executor_session_token_authorities.task_id': classify(
    'Include task-bound authorities before deleting their lookup rows.'
  ),
  'sessions.parent_session_id': clear(
    'Detach surviving sessions; ancestry never grants deletion ownership.'
  ),
  'sessions.forked_from_session_id': clear(
    'Detach surviving sessions; do not cascade across branches.'
  ),
  'sessions.data.genealogy': clear(
    'Remove deleted child IDs and deleted task fork/spawn points in surviving sessions.'
  ),
  'sessions.data.callback_config': clear(
    'Disable callbacks to deleted sessions; late work must honor maintenance admission.'
  ),
  'sessions.data.custom_context': classify(
    'Review gateway/scheduler structured routing references; do not rewrite arbitrary user text.'
  ),
  'tasks.data.metadata': classify(
    'Reconcile callback/widget/recovery IDs without deleting foreign tasks.'
  ),
  'messages.data': owned(
    'Owned transcript, widget and attachment snapshots; retain no copies in deletion diagnostics.'
  ),
  'board_comments.parent_comment_id': clear(
    'Detach surviving shared replies; never infer their ownership from a parent ID.'
  ),
  'board_comments.data.position.relative': clear(
    'Clear branch/session anchors for shared discussion.'
  ),
  'users.data.primary_teammate_id': clear('User remains; clear its teammate preference.'),
  'branches.data.custom_context.teammate.kb': classify(
    'Remove grants to deleted namespaces from surviving teammates. A surviving primary-namespace dependency requires explicit reconciliation, not deletion of that teammate. Include legacy assistant/persisted-agent configuration aliases.'
  ),
  'kb_documents.updated_by_session_id': clear('Clear provenance in surviving shared documents.'),
  'kb_document_versions.created_by_session_id': clear(
    'Clear provenance without deleting shared immutable content.'
  ),
  'kb_documents.current_version_id': owned(
    'Clear owned document pointer before leaf-first version deletion.'
  ),
  'kb_unit_embeddings.unit_id': owned(
    'Imperative PostgreSQL table: delete owned unit vectors using the Knowledge storage owner.'
  ),
  'artifact_trust_grants.scope_value': retain(
    'Persisted scopes are artifact, author, or instance, not branch. Preserve grants for surviving published artifacts; retire process-local session trust with its runtime.'
  ),
  workspace: owned(
    'Verify managed root, mount, generation and executor location; deregister worktrees without deleting the base repository.'
  ),
  'sdk_home.branch': owned(
    'Remove the exclusively owned branch home at its actual storage location.'
  ),
  'sdk_home.execution_home': classify(
    'Never erase a shared user home; unidentifiable historical provider state is a disclosed retention limitation.'
  ),
  environment: owned(
    'Admission rejects known active environment commands and starting/running/stopping state. This initial proxy is not proof of teardown of unmanaged external resources.'
  ),
  terminals: owned(
    'Close managed terminal attachments using the existing mechanism. The approved initial activity proxy does not prove detached/unmanaged shells stopped; do not describe it as containment evidence.'
  ),
  runtime_callbacks_and_tokens: owned(
    'Revoke normal admission while allowing fenced containment acknowledgements; invalidate process-local authorities too.'
  ),
  shared_repos_users_boards_credentials: retain(
    'Surviving owners retain their data; never traverse references upward.'
  ),
  provider_conversations_and_remote_git: retain(
    'No implicit provider conversation erasure or remote Git ref deletion.'
  ),
  backups_and_versioned_objects: classify(
    'Live-object deletion is not historical-version erasure. Retention locks require owner policy and explicit evidence.'
  ),
  cold_storage_and_recovery_blobs: classify(
    'No backend is present in this checkout; a future backend must register owned manifests and reference-aware shared-blob GC before enabling deletion.'
  ),
};
