import {
  BoardRepository,
  BranchRepository,
  MessagesRepository,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { type AuthenticatedParams, type BoardID, ROLES, type UserID } from '@agor/core/types';

/** Shared service-layer boundary used by REST, Socket.IO, MCP, and custom routes. */
export class CollaborationAuthorization {
  private readonly boards: BoardRepository;
  private readonly branches: BranchRepository;
  private readonly sessions: SessionRepository;
  private readonly tasks: TaskRepository;
  private readonly messages: MessagesRepository;

  constructor(
    db: TenantScopeAwareDatabase,
    private readonly enabled: boolean,
    private readonly allowSuperadmin = true
  ) {
    this.boards = new BoardRepository(db);
    this.branches = new BranchRepository(db);
    this.sessions = new SessionRepository(db);
    this.tasks = new TaskRepository(db);
    this.messages = new MessagesRepository(db);
  }

  private externalUser(params: Pick<AuthenticatedParams, 'provider' | 'user'> | undefined) {
    if (!this.enabled || !params?.provider) return null;
    const user = params.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    if (user._isServiceAccount) return null;
    if (user.role === ROLES.ADMIN || (this.allowSuperadmin && user.role === ROLES.SUPERADMIN)) {
      return null;
    }
    return user;
  }

  async requireBoard(
    params: Pick<AuthenticatedParams, 'provider' | 'user'> | undefined,
    boardId: BoardID | string,
    mode: 'view' | 'mutate'
  ): Promise<void> {
    const user = this.externalUser(params);
    if (!user) return;
    const allowed =
      mode === 'view'
        ? await this.boards.canView(boardId, user.user_id as UserID)
        : await this.boards.canMutate(boardId, user.user_id as UserID);
    if (!allowed) throw new Forbidden('Board resource not found or not accessible');
  }

  async requireBranchOnBoard(
    params: Pick<AuthenticatedParams, 'provider' | 'user'> | undefined,
    boardId: BoardID | string,
    branchId: string
  ): Promise<void> {
    if (!this.enabled || !params?.provider) return;
    const branch = await this.branches.findById(branchId);
    if (!branch || branch.board_id !== boardId) {
      throw new Forbidden('Attached resource does not belong to this board');
    }
    const user = this.externalUser(params);
    if (!user) return;
    const accessible = await this.branches.findAccessibleBranches(user.user_id as UserID);
    if (!accessible.some((candidate) => candidate.branch_id === branch.branch_id)) {
      throw new Forbidden('Attached resource not found or not accessible');
    }
  }

  /**
   * Validate every supplied attachment, require one common branch, and prove
   * that branch belongs to the selected board. Returns whether attachments exist.
   */
  async requireCommentAttachments(
    params: Pick<AuthenticatedParams, 'provider' | 'user'> | undefined,
    input: {
      boardId: BoardID | string;
      branchId?: string | null;
      sessionId?: string | null;
      taskId?: string | null;
      messageId?: string | null;
    }
  ): Promise<boolean> {
    const hasAttachments = Boolean(
      input.branchId || input.sessionId || input.taskId || input.messageId
    );
    if (!hasAttachments || !this.enabled || !params?.provider) return hasAttachments;

    const branchIds = new Set<string>();
    if (input.branchId) branchIds.add(input.branchId);
    if (input.sessionId) {
      const session = await this.sessions.findById(input.sessionId);
      if (!session) throw new Forbidden('Attached session not found or not accessible');
      branchIds.add(session.branch_id);
    }
    if (input.taskId) {
      const task = await this.tasks.findById(input.taskId);
      if (!task) throw new Forbidden('Attached task not found or not accessible');
      const session = await this.sessions.findById(task.session_id);
      if (!session) throw new Forbidden('Attached task not found or not accessible');
      branchIds.add(session.branch_id);
    }
    if (input.messageId) {
      const message = await this.messages.findById(input.messageId as never);
      if (!message) throw new Forbidden('Attached message not found or not accessible');
      const session = await this.sessions.findById(message.session_id);
      if (!session) throw new Forbidden('Attached message not found or not accessible');
      branchIds.add(session.branch_id);
    }
    if (branchIds.size !== 1) throw new Forbidden('Comment attachments must share one branch');
    await this.requireBranchOnBoard(params, input.boardId, [...branchIds][0]!);
    return true;
  }

  async canViewBoard(
    params: Pick<AuthenticatedParams, 'provider' | 'user'> | undefined,
    boardId: BoardID | string
  ): Promise<boolean> {
    try {
      await this.requireBoard(params, boardId, 'view');
      return true;
    } catch (error) {
      if (error instanceof Forbidden) return false;
      throw error;
    }
  }
}
