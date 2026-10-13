import { describe, expect, it } from 'vitest';
import {
  ALREADY_DONE,
  CLIENT_NOT_CONNECTED_ERROR,
  describeActionError,
  formatActionError,
  isAlreadyDone,
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

  it('keeps readable server text as is, in brackets', () => {
    // branches.ts
    expect(
      formatActionError(
        'start the environment',
        new Error('Environment configuration changed; refresh before retrying'),
        {
          idempotent: false,
        }
      )
    ).toBe(
      "Couldn't start the environment. (Environment configuration changed; refresh before retrying)"
    );
    expect(formatActionError('create the board', 'nope', { idempotent: false })).toBe(
      "Couldn't create the board. (nope)"
    );
  });
});

/** A Feathers error as the client receives it: class name, status code and the server's text. */
function feathersError(
  name: 'Forbidden' | 'NotFound' | 'BadRequest' | 'Conflict',
  message: string
) {
  const code = { Forbidden: 403, NotFound: 404, BadRequest: 400, Conflict: 409 }[name];
  return Object.assign(new Error(message), { name, code });
}

describe('server texts written for agents, the CLI or internals', () => {
  // One verbatim producer string per entry.
  it.each([
    [
      'sessions.ts',
      'start the session',
      'Branch working directory is not available (filesystem_status="preserved"). Restore or re-provision the branch before starting a session.',
      "This branch's files aren't available, so restore the branch first.",
    ],
    [
      'sessions.ts',
      'archive the session',
      "You need 'prompt' permission to archive sessions in this branch. You have 'view' permission.",
      "Your access to this branch doesn't allow this.",
    ],
    [
      'branch-authorization.ts',
      'update the branch',
      "You need 'all' permission to update branches. You have 'session' permission.",
      'You need full control of this branch to do this.',
    ],
    [
      'branch-authorization.ts',
      'stop the environment',
      "You need 'all' branch permission or admin access to stop branch environments",
      'You need full control of this branch to do this.',
    ],
    [
      'branches.ts',
      'start the environment',
      'No start command configured',
      "Add the command in the branch's Environment settings first.",
    ],
    [
      'repos.ts',
      'create the branch',
      "Board 'roadmap' not found. Provide a valid boardId (use agor_boards_list to see available boards).",
      'It may have been deleted, or you may not have access.',
    ],
    [
      'register-routes.ts',
      'unarchive the branch',
      'Branch not found: 019a2b3c-0000-7000-8000-000000000000',
      'It may have been deleted, or you may not have access.',
    ],
    [
      'repos.ts',
      'add the repository',
      "Repository 'agor' already exists.\nUse a different slug with: --slug custom/name",
      'A repository with that name is already added.',
    ],
    [
      'scheduler.ts',
      'run the schedule now',
      'An active run from schedule "Nightly" is already in progress and allow_concurrent_runs is disabled.',
      'A run from this schedule is still in progress.',
    ],
    [
      'register-hooks.ts',
      'delete the artifact',
      "Only the artifact's creator or an admin may modify it. Use agor_artifacts_publish to create your own copy.",
      "Only the artifact's creator or an administrator can change or delete it.",
    ],
    [
      'scheduler.ts',
      'run the schedule now',
      'This scheduled occurrence is waiting for its durable initialization retry.',
      'This run is already queued to try again.',
    ],
    [
      'knowledge-documents.ts',
      'archive the page',
      'Knowledge document version mismatch: expected 3, current is 4',
      'It changed since you opened it, so refresh and try again.',
    ],
    [
      'widgets/submissions.ts',
      'save the variables',
      'Widget 019a2b3c is already submitted; cannot submit again.',
      'This request was already answered. Refresh to see the result.',
    ],
  ])('%s: %s', (_source, action, serverText, reason) => {
    const error = feathersError('BadRequest', serverText);
    expect(formatActionError(action, error, { idempotent: true })).toBe(
      `Couldn't ${action}. ${reason}`
    );
    expect(describeActionError(action, error, { idempotent: true })).toEqual({
      message: `Couldn't ${action}. ${reason}`,
      raw: serverText,
      plainReason: true,
    });
  });

  it('keeps the raw text in brackets when the reason is only guessed from the status', () => {
    expect(
      formatActionError(
        'delete the MCP server',
        feathersError('Forbidden', 'MCP server is unavailable'),
        {
          idempotent: true,
        }
      )
    ).toBe(
      "Couldn't delete the MCP server. You don't have permission to do this. (MCP server is unavailable)"
    );
    expect(
      formatActionError(
        'update the session',
        feathersError('NotFound', 'No record found for id 1'),
        {
          idempotent: true,
        }
      )
    ).toBe(
      "Couldn't update the session. It may have been deleted, or you may not have access. (No record found for id 1)"
    );
  });

  it.each([
    // widgets/submissions.ts
    'Invalid submit payload: values.API_KEY: Required',
    // claude-backend-oauth.ts
    'Claude is disabled for this workspace.',
  ])('guesses no permission reason for a 403 that is not about permission: %j', (serverText) => {
    expect(
      formatActionError('connect', feathersError('Forbidden', serverText), { idempotent: true })
    ).toBe(`Couldn't connect. (${serverText})`);
  });

  it('says a widget is still being answered, not a permission problem', () => {
    // widgets/submissions.ts
    const error = feathersError(
      'Forbidden',
      'Widget 019a2b3c is already resolving; cannot submit again.'
    );
    expect(formatActionError('save the variables', error, { idempotent: true })).toBe(
      "Couldn't save the variables. This request is still being answered. Refresh in a moment to see the result."
    );
  });

  it('guesses no permission reason for a widget in another resolved state', () => {
    const error = feathersError(
      'Forbidden',
      'Widget 019a2b3c is already unavailable; cannot submit again.'
    );
    expect(formatActionError('save the variables', error, { idempotent: true })).toBe(
      "Couldn't save the variables. (Widget 019a2b3c is already unavailable; cannot submit again.)"
    );
  });
});

describe('isAlreadyDone', () => {
  // A retry after an unconfirmed request: the server says the end state already holds.
  it.each([
    [ALREADY_DONE.boardArchived, 'Board "Roadmap" is already archived'], // boards.ts
    [ALREADY_DONE.boardNotArchived, 'Board "Roadmap" is not archived'], // boards.ts
    [ALREADY_DONE.boardMissing, 'Board not found: 019a2b3c'], // register-hooks.ts
    [ALREADY_DONE.branchNotArchived, 'Branch feature-x is not archived'], // branches.ts
  ])('%s matches %j', (pattern, serverText) => {
    expect(isAlreadyDone(new Error(serverText), pattern)).toBe(true);
  });

  it('only for the end state it describes', () => {
    expect(
      isAlreadyDone(new Error('Board "Roadmap" is already archived'), ALREADY_DONE.boardNotArchived)
    ).toBe(false);
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
