import {
  ArtifactRepository,
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  type Database,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  RepoRepository,
  SessionRepository,
  UploadRepository,
  UsersRepository,
} from '@agor/core/db';
import type { SessionID, TenantID, UploadRef, UserID } from '@agor/core/types';

/**
 * A board with one branch everyone can see and one only its owner can see,
 * a conversation on each, and artifacts, documents, an app and uploads that
 * exercise every Files visibility rule.
 */
export async function seedBoardFiles(db: Database, tenantId = 'default', prefix = 'files') {
  const users = new UsersRepository(db);
  const owner = await users.create({ email: `${prefix}-owner@example.test`, role: 'member' });
  const viewer = await users.create({ email: `${prefix}-viewer@example.test`, role: 'member' });
  const outsider = await users.create({ email: `${prefix}-outsider@example.test`, role: 'member' });

  const board = await new BoardRepository(db).create({
    name: 'Files board',
    created_by: owner.user_id,
  });
  const policies = new CapabilityPolicyRepository(db);
  const policy = await policies.getBoardPolicies(board.board_id);
  await policies.replaceBoardPolicies(
    board.board_id,
    {
      ...policy,
      board_access: {
        ...policy.board_access,
        sharing_mode: 'shared',
        entries: [
          {
            entry_id: generateId(),
            principal: { principal_type: 'user', user_id: viewer.user_id },
            preset: 'viewer',
            capabilities: ['board.view'],
            fs_access: 'none',
          },
        ],
        others: { preset: 'none', capabilities: [], fs_access: 'none' },
      },
    },
    owner.user_id
  );

  const repo = await new RepoRepository(db).create({
    repo_type: 'remote',
    remote_url: `https://example.test/${prefix}.git`,
    slug: `${prefix}-repo`,
    local_path: `/tmp/${prefix}-repo`,
    default_branch: 'main',
  });
  const branches = new BranchRepository(db);
  const branch = (name: string, othersCan: 'view' | 'none', index: number, extra = {}) =>
    branches.create({
      repo_id: repo.repo_id,
      board_id: board.board_id,
      name,
      ref: name,
      branch_unique_id: index,
      created_by: owner.user_id,
      primary_owner_user_id: owner.user_id,
      permission_source: 'override',
      others_can: othersCan,
      ...extra,
    });
  const open = await branch('open', 'view', 1, {
    app_url: 'https://app.example.test',
    pull_request_url: 'https://github.com/example/repo/pull/14',
  });
  const hidden = await branch('hidden', 'none', 2);

  const sessions = new SessionRepository(db);
  const session = (branchId: string, title: string) =>
    sessions.create({
      session_id: generateId() as SessionID,
      branch_id: branchId,
      created_by: owner.user_id,
      agentic_tool: 'claude-code',
      title,
    });
  const kickoff = await session(open.branch_id, 'Kickoff');
  const secret = await session(hidden.branch_id, 'Secret plan');

  const artifacts = new ArtifactRepository(db);
  const artifact = (name: string, data: Record<string, unknown>) =>
    artifacts.create({
      board_id: board.board_id,
      branch_id: open.branch_id,
      name,
      public: true,
      created_by: owner.user_id,
      ...data,
    });
  const dashboard = await artifact('Northwind dashboard', {
    source_session_id: kickoff.session_id,
    build_status: 'success',
    description: 'Quarterly usage',
  });
  const privateDraft = await artifact('Private draft', {
    source_session_id: kickoff.session_id,
    public: false,
  });
  const hiddenBranchArtifact = await artifact('Hidden branch chart', {
    branch_id: hidden.branch_id,
    source_session_id: secret.session_id,
  });
  const archivedChart = await artifacts.update(
    (await artifact('Old chart', { source_session_id: kickoff.session_id })).artifact_id,
    { archived: true }
  );
  const fromSecret = await artifact('Renewal list', { source_session_id: secret.session_id });

  const namespace = await new KnowledgeNamespaceRepository(db).create({
    slug: `${prefix}-notes`,
    display_name: 'Notes',
    others_can: 'read',
    visibility_default: 'public',
    created_by: owner.user_id as UserID,
  });
  const documents = new KnowledgeDocumentRepository(db);
  const doc = (path: string, title: string, data: Record<string, unknown>) =>
    documents.create({
      namespace_id: namespace.namespace_id,
      path,
      title,
      content_text: `# ${title}`,
      created_by: owner.user_id as UserID,
      visibility: 'public',
      ...data,
    });
  const talkingPoints = await doc('qbr/talking-points.md', 'Talking points', {
    updated_by_session_id: kickoff.session_id,
  });
  const memory = await doc('memory/notes.md', 'Memory notes', {
    kind: 'memory',
    updated_by_session_id: kickoff.session_id,
  });
  const secretDoc = await doc('plans/secret.md', 'Secret summary', {
    updated_by_session_id: secret.session_id,
  });
  const ownerDraft = await doc('drafts/next.md', 'Next steps', {
    status: 'draft',
    updated_by_session_id: kickoff.session_id,
  });

  const uploads = new UploadRepository(db);
  const upload = (name: string, sessionId: string, branchId: string, createdBy: string) =>
    uploads.create(
      {
        tenantId: tenantId as TenantID,
        sessionId: sessionId as SessionID,
        branchId,
        createdBy: createdBy as UserID,
      },
      {
        ref: `upl_${generateId()}` as UploadRef,
        name,
        mimeType: 'application/pdf',
        size: 2048,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        provenance: 'browser',
      }
    );
  const orderForm = await upload(
    'order-form.pdf',
    kickoff.session_id,
    open.branch_id,
    owner.user_id
  );
  const secretUpload = await upload(
    'secret.pdf',
    secret.session_id,
    hidden.branch_id,
    owner.user_id
  );
  const viewerUpload = await upload(
    'viewer-notes.pdf',
    secret.session_id,
    hidden.branch_id,
    viewer.user_id
  );

  return {
    owner,
    viewer,
    outsider,
    board,
    open,
    hidden,
    kickoff,
    secret,
    artifacts: { dashboard, privateDraft, hiddenBranchArtifact, archivedChart, fromSecret },
    docs: { talkingPoints, memory, secretDoc, ownerDraft },
    uploads: { orderForm, secretUpload, viewerUpload },
  };
}
