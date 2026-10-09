import { describe, expect, it } from 'vitest';
import {
  CLIENT_NOT_CONNECTED_ERROR,
  describeActionError,
  describeRejection,
  formatActionError,
  isAlreadyDoneError,
  isInFlightConnectionLossError,
  SOCKET_ACK_TIMEOUT_ERROR,
  SOCKET_DISCONNECTED_ERROR,
  sessionStartedMessageNotSent,
} from './connectionErrors';

describe('isInFlightConnectionLossError', () => {
  it.each(['socket has been disconnected', 'operation has timed out'])(
    'recognises socket.io-client %j',
    (message) => {
      expect(isInFlightConnectionLossError(new Error(message))).toBe(true);
      expect(isInFlightConnectionLossError(message)).toBe(true);
      expect(isInFlightConnectionLossError({ message })).toBe(true);
    }
  );

  it.each([
    'Session is busy',
    'the socket has been disconnected by the server',
    'Socket Has Been Disconnected',
    CLIENT_NOT_CONNECTED_ERROR,
    '',
  ])('rejects %j', (message) => {
    expect(isInFlightConnectionLossError(new Error(message))).toBe(false);
  });

  it.each([null, undefined, 42])('rejects non-error value %j', (value) => {
    expect(isInFlightConnectionLossError(value)).toBe(false);
  });
});

describe('formatActionError', () => {
  it('advises a retry when nothing was sent', () => {
    for (const idempotent of [true, false]) {
      expect(
        formatActionError('create the board', new Error(CLIENT_NOT_CONNECTED_ERROR), { idempotent })
      ).toBe(
        "Couldn't create the board. The connection to Agor dropped. Try again once it's back. (Client not connected)"
      );
    }
  });

  it('suggests a retry after an in-flight loss only when repeating is harmless', () => {
    expect(
      formatActionError('archive the branch', new Error(SOCKET_DISCONNECTED_ERROR), {
        idempotent: true,
      })
    ).toBe(
      "The connection to Agor dropped before this was confirmed. If it didn't go through, try to archive the branch again once the connection is back. (socket has been disconnected)"
    );
  });

  it('asks the user to check before repeating a create whose outcome is unknown', () => {
    expect(
      formatActionError('fork the session', new Error(SOCKET_ACK_TIMEOUT_ERROR), {
        idempotent: false,
      })
    ).toBe(
      'The connection to Agor dropped before this was confirmed. Refresh to see if it went through before you try to fork the session again. (operation has timed out)'
    );
  });

  it('shows the server text in brackets only when there is no plain reason', () => {
    // register-routes.ts: a known reason, so no bracket.
    expect(
      formatActionError(
        'start the scheduled run',
        new Error(
          'Branch "feature-x" has no schedules. Create one and call POST /schedules/:id/run-now instead.'
        ),
        { idempotent: false }
      )
    ).toBe(
      "Couldn't start the scheduled run. This branch has no schedules yet, so create one first."
    );
    // An unknown rejection: the server text is the only reason.
    expect(
      formatActionError('save the card', new Error('title is required'), { idempotent: true })
    ).toBe("Couldn't save the card. (title is required)");
  });

  it('leads with the action and keeps an unknown reason raw, in brackets', () => {
    expect(
      formatActionError('update the board', new Error('Board name required'), { idempotent: true })
    ).toBe("Couldn't update the board. (Board name required)");
    expect(formatActionError('create the board', 'nope', { idempotent: false })).toBe(
      "Couldn't create the board. (nope)"
    );
  });
});

/** A Feathers error as the client receives it: class name, status code and the server's text. */
function feathersError(name: 'Forbidden' | 'NotFound' | 'BadRequest', message: string) {
  const code = { Forbidden: 403, NotFound: 404, BadRequest: 400 }[name];
  return Object.assign(new Error(message), { name, code });
}

describe('describeRejection', () => {
  // One literal server string per entry, copied from the daemon (see each comment).
  it.each([
    // sessions.ts
    [
      'delete the session',
      'Cannot delete session 019a2b3c while it has unfinished tasks. Stop them first.',
      "It's still running, so stop it first.",
    ],
    // branch-authorization.ts
    [
      'fork the session',
      'This branch does not allow shared session prompting.',
      "This branch doesn't allow others to start sessions here.",
    ],
    // sessions.ts
    [
      'start the session',
      'Branch working directory is not available (filesystem_status="cleaned"). Restore or re-provision the branch before starting a session.',
      "This branch's files were removed, so restore them first.",
    ],
    // sessions.ts
    [
      'start the session',
      "You need 'prompt' permission to create sessions in this branch. You have 'view' permission.",
      "You don't have permission to start sessions on this branch.",
    ],
    // branch-authorization.ts
    [
      'update the branch',
      "You need 'all' permission to update branches. You have 'session' permission.",
      'You need full control of this branch to change it.',
    ],
    // register-routes.ts (ensureBranchPermission 'all')
    [
      'start the scheduled run',
      "You need 'all' permission to run schedule. You have 'prompt' permission.",
      'You need full control of this branch to run schedules.',
    ],
    // branch-authorization.ts
    [
      'stop the environment',
      "You need 'all' branch permission or admin access to stop environments",
      'You need full control of this branch to control its environment.',
    ],
    // repos.ts
    [
      'create the branch',
      "A branch named 'feature-x' already exists in this repository",
      'A branch with that name already exists, so choose another name.',
    ],
    // repos.ts
    [
      'create the branch',
      "An archived branch named 'feature-x' still owns this workspace path. Unarchive it instead of creating a new branch.",
      'An archived branch already uses this name, so unarchive it instead.',
    ],
    // repos.ts
    [
      'create the branch',
      "Board 'roadmap' not found. Provide a valid boardId (use agor_boards_list to see available boards).",
      'That board no longer exists.',
    ],
    // register-hooks.ts
    [
      'update the branch',
      'Board Editor or Manager access is required to attach a branch',
      'You need edit access to this board.',
    ],
    // register-hooks.ts
    [
      'save your change',
      'You need Board Editor or Manager access to update this board',
      'You need edit access to this board.',
    ],
    // zone-trigger.ts
    [
      "run the zone's trigger",
      'Zone "Review" has no trigger template configured',
      'Add a prompt template in zone settings first.',
    ],
    // zone-trigger.ts
    [
      "run the zone's trigger",
      'Zone "Review" trigger rendered to an empty prompt; not creating session',
      'Its prompt template came out empty, so check it in zone settings.',
    ],
    // authorization.ts via register-hooks.ts
    [
      'create the board',
      'You need member access to create boards',
      'Only members and administrators can create boards.',
    ],
    // repos.ts
    [
      'add the repository',
      "Repository 'agor' already exists.\nUse a different slug with: --slug custom/name",
      'A repository with that name is already added.',
    ],
    // executor git.ts
    [
      'add the repository',
      'Path must be absolute: code/agor',
      'Use the full path, starting with /.',
    ],
    // executor git.ts
    [
      'add the repository',
      'Not a valid git repository: /tmp/empty',
      "That folder isn't a Git repository.",
    ],
    // repos.ts
    [
      'add the repository',
      'Local repository registration is unavailable in hosted multi-tenant mode.',
      "Local repositories aren't available here.",
    ],
    // repos.ts
    [
      'update the repository',
      "A repository with slug 'agor' already exists",
      'Another repository already uses that name.',
    ],
    // repos.ts
    [
      'delete the repository',
      'Permanently delete this repository’s branches first and wait for completion before removing the repository.',
      'Delete its branches first, then try again.',
    ],
    // repos.ts
    [
      'delete the repository',
      'SAFETY CHECK FAILED: refusing to delete /',
      'Agor stopped early to protect your files, so please report this.',
    ],
    // register-routes.ts
    [
      'start the scheduled run',
      'Branch "feature-x" has no schedules. Create one and call POST /schedules/:id/run-now instead.',
      'This branch has no schedules yet, so create one first.',
    ],
    // register-routes.ts
    [
      'start the scheduled run',
      'Branch "feature-x" has 2 schedules. This route is back-compat only for the single-schedule case. Pick one and call POST /schedules/:id/run-now.',
      'This branch has several schedules, so run one from the Schedules tab.',
    ],
    // scheduler.ts
    [
      'start the scheduled run',
      'An active run from schedule "Nightly" is already in progress and allow_concurrent_runs is disabled.',
      'A run from this schedule is still in progress.',
    ],
    // scheduler.ts
    [
      'start the scheduled run',
      'Schedule creator 019a2b3c no longer has Collaborator access to branch 019a2b3d',
      "The schedule's creator no longer has access to this branch.",
    ],
    // register-routes.ts
    [
      'start the scheduled run',
      'Scheduler service is not enabled on this instance.',
      'Schedules are turned off for this workspace.',
    ],
    // branches.ts
    [
      'start the environment',
      'No start command configured for this branch',
      "Add a start command in the branch's Environment settings first.",
    ],
    // environment-commands.ts
    [
      'stop the environment',
      'An environment command is still active; wait for its result or deadline',
      'The last environment command is still running, so wait for it to finish.',
    ],
    // environment-commands.ts
    [
      'start the environment',
      'Environment is already running or waiting for health; Stop it first',
      "It's already running, so stop it first.",
    ],
    // environment-commands.ts
    [
      'start the environment',
      'Previous environment cleanup is unconfirmed. Refresh and explicitly confirm Start anyway for the current attempt.',
      "Agor couldn't confirm the last cleanup, so refresh and choose Start anyway.",
    ],
    // environment-commands.ts
    [
      'start the environment',
      'Environment configuration changed; refresh before retrying',
      'Its settings changed, so refresh and try again.',
    ],
    // environment-commands.ts
    [
      'nuke the environment',
      'Environment commands require a ready, non-archived branch',
      'The branch must be set up and not archived.',
    ],
    // mcp-server-authorization.ts
    [
      'add the MCP server',
      'Only admins can configure stdio MCP servers; members can configure remote (http/sse) servers',
      'Only administrators can add servers that run a command, but members can add servers by URL.',
    ],
    // register-hooks.ts
    [
      'update the artifact',
      "Only the artifact's creator or an admin may modify it. Use agor_artifacts_publish to create your own copy.",
      "Only the artifact's creator or an administrator can change it.",
    ],
    [
      'delete the artifact',
      "Only the artifact's creator or an admin may modify it. Use agor_artifacts_publish to create your own copy.",
      "Only the artifact's creator or an administrator can delete it.",
    ],
    // authorization.ts via register-hooks.ts
    [
      'create the channel',
      'You need admin access to create gateway channels',
      'Only administrators can create channels.',
    ],
    [
      'save the channel',
      'You need admin access to update gateway channels',
      'Only administrators can change channels.',
    ],
    // authorization.ts via register-hooks.ts
    [
      'post the comment',
      'You need member access to create board comments',
      'Only members and administrators can comment.',
    ],
    // register-hooks.ts
    [
      'resolve the comment',
      'Only the comment author may update this board comment',
      "Only the comment's author or an administrator can do this.",
    ],
    // users.ts
    [
      'delete the user',
      'This user still owns boards or branches. Delete those resources before deleting the user.',
      'They still own boards or branches, so delete those first.',
    ],
    // users.ts
    [
      'create the user',
      'User with email ada@example.com already exists',
      'A user with that email already exists.',
    ],
    // mcp-marketplace-actions.ts
    [
      'remove the server',
      'Session attachments changed. Review the current count and confirm deletion again.',
      'The sessions using it changed, so check the count and confirm again.',
    ],
    // widgets/oauth/index.ts
    [
      'connect',
      'MCP OAuth status is unavailable on this daemon; try Connect again.',
      "Agor couldn't check the sign-in status, so try Connect again.",
    ],
    // widgets/oauth/index.ts
    [
      'connect',
      'Only admins can connect a shared MCP OAuth server',
      'Only administrators can connect a shared MCP server.',
    ],
    // widgets/oauth/index.ts
    [
      'connect',
      'Sign-in to "Linear" has not completed. Finish the provider sign-in, then try Connect again.',
      "Sign-in hasn't finished, so finish it in the provider window and try Connect again.",
    ],
    // widgets/oauth/index.ts
    [
      'connect',
      'Agor is still finishing the connection to "Linear". Wait a moment, then press Connect again — you should not need to sign in again.',
      'Agor is still finishing the connection, so wait a moment and try Connect again.',
    ],
    // widgets/oauth/index.ts
    [
      'connect',
      'That MCP server is not available to you',
      "This MCP server isn't available to you.",
    ],
    // widgets/oauth/index.ts
    [
      'connect',
      '"Linear" is no longer an enabled OAuth MCP server; reconfigure it and ask again.',
      "This MCP server is no longer set up for sign-in, so ask the agent again after it's fixed.",
    ],
    // widgets/oauth/index.ts
    [
      'connect',
      '"Linear" changed OAuth mode since this request was made; ask again.',
      "This MCP server's sign-in settings changed, so ask the agent again.",
    ],
    // widgets/submissions.ts
    [
      'save the variables',
      'Widget 019a2b3c is already submitted; cannot submit again.',
      'It was already answered, so refresh to see the result.',
    ],
    // widgets/gateway-token/index.ts
    [
      'save the tokens',
      'Only admins can set gateway channel tokens',
      'Only administrators can set channel tokens.',
    ],
    // widgets/gateway-token/index.ts
    [
      'save the tokens',
      'Gateway channel 019a2b3c not found',
      'This request no longer matches the channel, so ask the agent to request the tokens again.',
    ],
    // widgets/gateway-token/index.ts
    [
      'save the tokens',
      'Gateway channel type does not match the widget request',
      'This request no longer matches the channel, so ask the agent to request the tokens again.',
    ],
    // widgets/gateway-token/index.ts
    [
      'save the tokens',
      "Gateway channel is not bound to this session's branch",
      'This request no longer matches the channel, so ask the agent to request the tokens again.',
    ],
    // github-app-setup.ts
    [
      'start the GitHub App install',
      'Admin role required to initiate GitHub App install',
      'Only administrators can install the GitHub App.',
    ],
    // github-app-setup.ts
    [
      'start the GitHub App install',
      'Authentication required to initiate GitHub App install',
      'Sign in again first.',
    ],
    // github-app-setup.ts
    [
      'start the GitHub App install',
      'GitHub App install setup is temporarily unavailable',
      "Agor can't start installs right now, so try again later.",
    ],
    // schedules.ts
    [
      'save the schedule',
      'MCP server 019a2b3c is private to another user. Schedules run as their creator, so only shared servers or servers the creator owns can be attached.',
      "It uses another user's private MCP server, so choose a shared one.",
    ],
    // scheduler.ts
    [
      'start the scheduled run',
      'This scheduled occurrence is waiting for its durable initialization retry.',
      'This run is already queued to try again.',
    ],
    // knowledge-documents.ts
    [
      'archive the page',
      'Knowledge document archive state changed; reload before retrying',
      'It changed since you opened it, so refresh and try again.',
    ],
    // knowledge-documents.ts
    [
      'restore the page',
      'Knowledge document version mismatch: expected 3, current is 4',
      'It changed since you opened it, so refresh and try again.',
    ],
    // upload-http-error.ts via FileUpload/upload.ts
    [
      'upload the files',
      'Unsupported file type (reference: req-7f3a)',
      "Agor doesn't accept this file type.",
    ],
    // upload-http-error.ts
    ['upload the files', 'A file exceeds the upload size limit', 'A file is over the size limit.'],
    // upload-http-error.ts
    [
      'upload the files',
      'Combined upload size exceeds the upload size limit',
      'The files together are over the size limit.',
    ],
    // upload-http-error.ts
    ['upload the files', 'Too many files', 'Too many files at once.'],
    // upload-http-error.ts
    [
      'upload the files',
      'Upload too large (reference: req-7f3a)',
      'The upload is over the size limit.',
    ],
  ])('%s: %j', (action, serverText, reason) => {
    const error = feathersError('BadRequest', serverText);
    expect(describeRejection(action, error)).toEqual({ reason, passThrough: false });
    // The plain reason replaces the server text: no bracket.
    expect(formatActionError(action, error, { idempotent: true })).toBe(
      `Couldn't ${action}. ${reason}`
    );
    // Banners still get the server text under Details.
    expect(describeActionError(action, error, { idempotent: true })).toEqual({
      message: `Couldn't ${action}. ${reason}`,
      raw: error.message,
      plainReason: true,
    });
  });

  it.each([
    'Schedule is disabled. Enable it before running manually.',
    'Schedules run as the user who created them. You can only manually run schedules you created.',
    'That MCP server was not found. Remove the unavailable selection from MCP Servers and try again.',
    "You don't have permission to prompt this branch. Only Collaborators and Managers can prompt sessions on it.",
  ])('passes plain server text through without brackets: %j', (serverText) => {
    expect(
      formatActionError('send your message', feathersError('Forbidden', serverText), {
        idempotent: false,
      })
    ).toBe(`Couldn't send your message. ${serverText}`);
  });

  it('matches a verbatim string before the Feathers class fallback', () => {
    // register-hooks.ts: a non-admin gets Forbidden for a board that no longer exists.
    expect(
      describeRejection('delete the board', feathersError('Forbidden', 'Board not found: 019a2b3c'))
    ).toEqual({
      reason: 'It may have been deleted, or you may not have access.',
      passThrough: false,
    });
  });

  it('falls back to the Feathers class for other 403 and 404 rejections', () => {
    expect(
      formatActionError(
        'delete the MCP server',
        feathersError('Forbidden', 'MCP server is unavailable'),
        { idempotent: true }
      )
    ).toBe("Couldn't delete the MCP server. You don't have permission to do this.");
    expect(
      formatActionError(
        'update the session',
        feathersError('NotFound', 'No record found for id 1'),
        {
          idempotent: true,
        }
      )
    ).toBe("Couldn't update the session. It may have been deleted, or you may not have access.");
  });

  it('shows the raw text for a known 403 whose cause is not permission', () => {
    // widgets/submissions.ts
    expect(
      formatActionError(
        'save the variables',
        feathersError('Forbidden', 'Invalid submit payload: values.API_KEY: Required'),
        { idempotent: false }
      )
    ).toBe("Couldn't save the variables. (Invalid submit payload: values.API_KEY: Required)");
  });

  it('gives no reason for an unknown rejection', () => {
    expect(
      describeRejection('save the card', feathersError('BadRequest', 'title is required'))
    ).toBe(null);
  });
});

describe('isAlreadyDoneError', () => {
  // A replay after the #2992 "try again" copy: the server says the end state already holds.
  it.each([
    ['archive the board', 'Board "Roadmap" is already archived'], // boards.ts
    ['unarchive the board', 'Board "Roadmap" is not archived'], // boards.ts
    ['delete the board', 'Board not found: 019a2b3c'], // register-hooks.ts
    ['unarchive the branch', 'Branch feature-x is not archived'], // branches.ts
  ])('%s: %j counts as done', (action, serverText) => {
    expect(isAlreadyDoneError(action, new Error(serverText))).toBe(true);
  });

  it('only for the action whose end state it describes', () => {
    expect(
      isAlreadyDoneError('unarchive the board', new Error('Board "Roadmap" is already archived'))
    ).toBe(false);
    expect(isAlreadyDoneError('archive the board', new Error('Board not found: 019a2b3c'))).toBe(
      false
    );
  });
});

describe('sessionStartedMessageNotSent', () => {
  it('says the message may have landed after a lost reply', () => {
    expect(sessionStartedMessageNotSent(new Error(SOCKET_DISCONNECTED_ERROR))).toBe(
      'The session started, but the connection to Agor dropped before your message was confirmed. Open the session to check before you send it again. (socket has been disconnected)'
    );
  });

  it('asks the user to send it from the session otherwise', () => {
    expect(sessionStartedMessageNotSent(new Error('Session is busy'))).toBe(
      "The session started, but your first message wasn't sent. Open the session to send it. (Session is busy)"
    );
  });
});
