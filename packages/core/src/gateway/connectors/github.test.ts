import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../connector';
import {
  classifyGitHubInstallationError,
  GitHubConnector,
  githubIssueCommentProviderEventId,
} from './github';

const githubApi = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  listCommentsForRepo: vi.fn(),
  paginateIterator: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  createForIssueComment: vi.fn(),
  getByUsername: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class MockOctokit {
    apps = { getInstallation: githubApi.getInstallation };
    paginate = { iterator: githubApi.paginateIterator };
    issues = {
      listCommentsForRepo: githubApi.listCommentsForRepo,
      createComment: githubApi.createComment,
      updateComment: githubApi.updateComment,
    };
    reactions = { createForIssueComment: githubApi.createForIssueComment };
    users = { getByUsername: githubApi.getByUsername };
  },
}));

vi.mock('@octokit/auth-app', () => ({ createAppAuth: vi.fn() }));

const NOW = new Date('2026-08-14T12:00:00.000Z');
const REPO = 'preset-io/agor';

function connectorConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app_id: 1,
    private_key: 'test-private-key',
    installation_id: 2,
    watch_repos: [REPO],
    poll_interval_ms: 60 * 60 * 1000,
    ...overrides,
  };
}

function issueComment(
  id: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    node_id: `IC_${id}`,
    body: `@agor handle comment ${id}`,
    issue_url: 'https://api.github.com/repos/preset-io/agor/issues/42',
    html_url: `https://github.com/preset-io/agor/issues/42#issuecomment-${id}`,
    created_at: `2026-08-14T11:5${id % 10}:00.000Z`,
    user: {
      login: `user-${id}`,
      type: 'User',
      html_url: `https://github.com/user-${id}`,
    },
    ...overrides,
  };
}

async function listenOnce(
  connector: GitHubConnector,
  callback: (message: InboundMessage) => Promise<void> | void = () => undefined,
  options: {
    checkpoint?: Record<string, unknown>;
    durableEventIdempotency?: boolean;
  } = {}
): Promise<Record<string, unknown> | undefined> {
  let checkpoint: Record<string, unknown> | undefined;
  await connector.startListening(callback, {
    checkpoint: options.checkpoint,
    durableEventIdempotency: options.durableEventIdempotency ?? true,
    saveCheckpoint: async (value) => {
      checkpoint = value;
      return true;
    },
  });
  await connector.stopListening();
  return checkpoint;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const mock of Object.values(githubApi)) mock.mockReset();
  githubApi.getInstallation.mockResolvedValue({ data: {} });
  githubApi.paginateIterator.mockImplementation(async function* (
    endpoint: (request: Record<string, unknown>) => Promise<{
      data: Record<string, unknown>[];
      headers: { link?: string };
    }>,
    request: Record<string, unknown>
  ) {
    let page = 1;
    while (true) {
      const response = await endpoint({ ...request, page });
      yield response;
      if (!response.headers.link?.includes('rel="next"')) return;
      page += 1;
    }
  });
  githubApi.listCommentsForRepo.mockResolvedValue({ data: [], headers: { etag: 'etag-1' } });
  githubApi.createComment.mockResolvedValue({ data: { id: 900 } });
  githubApi.updateComment.mockResolvedValue({ data: {} });
  githubApi.createForIssueComment.mockResolvedValue({ data: {} });
  githubApi.getByUsername.mockResolvedValue({ data: { email: null } });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('classifyGitHubInstallationError', () => {
  it('keeps an ordinary permission 403 permanent', () => {
    expect(classifyGitHubInstallationError({ status: 403 })).toMatchObject({
      code: 'github_credentials_invalid',
      kind: 'permanent',
    });
  });

  it.each([
    { response: { headers: { 'retry-after': '60' } } },
    { response: { headers: { 'x-ratelimit-remaining': '0' } } },
    {
      response: {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1234' },
      },
    },
    { response: { data: { message: 'You have exceeded a secondary rate limit.' } } },
  ])('keeps a rate-limited 403 transient', (detail) => {
    expect(classifyGitHubInstallationError({ status: 403, ...detail })).toMatchObject({
      code: 'github_api_unavailable',
      kind: 'transient',
    });
  });

  it('does not treat a reset header with remaining capacity as rate limited', () => {
    expect(
      classifyGitHubInstallationError({
        status: 403,
        response: {
          headers: { 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '1234' },
        },
      })
    ).toMatchObject({ code: 'github_credentials_invalid', kind: 'permanent' });
  });
});

describe('githubIssueCommentProviderEventId', () => {
  it('uses the provider-stable node id when available', () => {
    expect(githubIssueCommentProviderEventId({ id: 42, node_id: 'IC_kwDOstable' })).toBe(
      'github:issue_comment:IC_kwDOstable'
    );
  });

  it('falls back to the globally assigned numeric comment id', () => {
    expect(githubIssueCommentProviderEventId({ id: 42 })).toBe('github:issue_comment:42');
  });
});

describe('GitHubConnector polling', () => {
  it('reads every comment page before advancing an overlap-safe checkpoint', async () => {
    const comments = Array.from({ length: 201 }, (_, index) => issueComment(index + 1));
    githubApi.listCommentsForRepo.mockImplementation(async ({ page }: { page: number }) => ({
      data: comments.slice((page - 1) * 100, page * 100),
      headers: { link: page < 3 ? '<https://api.github.test/comments>; rel="next"' : undefined },
    }));
    const connector = new GitHubConnector(connectorConfig());
    const received: InboundMessage[] = [];

    const checkpoint = await listenOnce(connector, (message) => {
      received.push(message);
    });

    expect(githubApi.listCommentsForRepo.mock.calls.map(([request]) => request.page)).toEqual([
      1, 2, 3,
    ]);
    expect(githubApi.paginateIterator).toHaveBeenCalledWith(
      githubApi.listCommentsForRepo,
      expect.objectContaining({
        owner: 'preset-io',
        repo: 'agor',
        per_page: 100,
      })
    );
    expect(
      new Set(githubApi.listCommentsForRepo.mock.calls.map(([request]) => request.since))
    ).toEqual(new Set(['2026-08-14T11:55:00.000Z']));
    expect(received).toHaveLength(201);
    expect(new Set(received.map(({ providerEventId }) => providerEventId)).size).toBe(201);
    expect(checkpoint).toMatchObject({
      repos: {
        [REPO]: {
          lastPollAt: '2026-08-14T11:59:00.000Z',
        },
      },
    });
    expect(checkpoint).not.toHaveProperty(['repos', REPO, 'lastEtag']);
  });

  it('lets the provider pagination iterator decide when there is another page', async () => {
    githubApi.listCommentsForRepo.mockResolvedValue({
      data: Array.from({ length: 100 }, (_, index) => issueComment(index + 1)),
      headers: {},
    });
    const connector = new GitHubConnector(connectorConfig());
    const received: InboundMessage[] = [];

    await listenOnce(connector, (message) => {
      received.push(message);
    });

    expect(received).toHaveLength(100);
    expect(githubApi.listCommentsForRepo).toHaveBeenCalledOnce();
  });

  it('admits only active human mentions and preserves GitHub routing metadata', async () => {
    githubApi.listCommentsForRepo.mockResolvedValue({
      data: [
        issueComment(1, { body: 'ordinary conversation' }),
        issueComment(2, { body: '`@agor example only`' }),
        issueComment(3, { user: { login: 'robot', type: 'Bot' } }),
        issueComment(4, { body: '@AgOr investigate this' }),
        issueComment(5, { body: '```ts\n@agor example only\n```' }),
      ],
      headers: { etag: 'mention-etag' },
    });
    const connector = new GitHubConnector(connectorConfig());
    const received: InboundMessage[] = [];

    await listenOnce(connector, (message) => {
      received.push(message);
    });

    expect(received).toEqual([
      expect.objectContaining({
        providerEventId: 'github:issue_comment:IC_4',
        threadId: 'preset-io/agor#42',
        text: 'investigate this',
        userId: 'user-4',
        metadata: expect.objectContaining({
          comment_id: 4,
          github_user: 'user-4',
          issue_number: 42,
          repo_full_name: REPO,
        }),
      }),
    ]);
  });

  it('defers acknowledgement side effects until prepareDelivery is invoked', async () => {
    githubApi.listCommentsForRepo.mockResolvedValue({
      data: [issueComment(7)],
      headers: { etag: 'ack-etag' },
    });
    const connector = new GitHubConnector(connectorConfig());
    let deliveryMetadata: Record<string, unknown> | undefined;

    await listenOnce(connector, async (message) => {
      expect(githubApi.createForIssueComment).not.toHaveBeenCalled();
      expect(githubApi.createComment).not.toHaveBeenCalled();
      deliveryMetadata = await message.prepareDelivery?.();
    });

    expect(githubApi.createForIssueComment).toHaveBeenCalledWith({
      owner: 'preset-io',
      repo: 'agor',
      comment_id: 7,
      content: 'eyes',
    });
    expect(githubApi.createComment).toHaveBeenCalledWith({
      owner: 'preset-io',
      repo: 'agor',
      issue_number: 42,
      body: '⏳ Processing...',
    });
    expect(deliveryMetadata).toEqual({ processing_comment_id: 900 });
  });

  it('restores its checkpoint when the durable callback rejects the occurrence', async () => {
    githubApi.listCommentsForRepo.mockResolvedValue({
      data: [issueComment(8)],
      headers: { etag: 'retry-etag' },
    });
    const connector = new GitHubConnector(connectorConfig());
    const rejected = vi.fn(async () => {
      throw new Error('durable admission failed');
    });

    await listenOnce(connector, rejected);
    const retried: InboundMessage[] = [];
    await listenOnce(connector, (message) => {
      retried.push(message);
    });

    expect(rejected).toHaveBeenCalledOnce();
    expect(retried.map(({ providerEventId }) => providerEventId)).toEqual([
      'github:issue_comment:IC_8',
    ]);
    expect(githubApi.listCommentsForRepo.mock.calls.map(([request]) => request.since)).toEqual([
      '2026-08-14T11:55:00.000Z',
      '2026-08-14T11:55:00.000Z',
    ]);
  });

  it('does not advance the cursor when a later page fails', async () => {
    const comments = Array.from({ length: 100 }, (_, index) => issueComment(index + 1));
    const sensitiveError = 'sensitive-page-failure';
    githubApi.listCommentsForRepo
      .mockResolvedValueOnce({
        data: comments,
        headers: { link: '<https://api.github.test/comments?page=2>; rel="next"' },
      })
      .mockRejectedValueOnce(new Error(sensitiveError));
    const connector = new GitHubConnector(connectorConfig());
    const received: InboundMessage[] = [];

    const checkpoint = await listenOnce(connector, (message) => {
      received.push(message);
    });

    expect(received).toHaveLength(100);
    expect(checkpoint).toMatchObject({
      repos: {
        [REPO]: {
          lastPollAt: '2026-08-14T11:55:00.000Z',
        },
      },
    });
    const output = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(output).toContain('event="poll_failed"');
    expect(output).not.toContain(sensitiveError);
  });

  it('polls later pages again when their contents can change independently', async () => {
    const comments = Array.from({ length: 102 }, (_, index) => issueComment(index + 1));
    githubApi.listCommentsForRepo.mockImplementation(async ({ page }: { page: number }) => ({
      data: comments.slice((page - 1) * 100, page * 100),
      headers: {
        etag: page === 1 ? 'unchanged-first-page-etag' : undefined,
        link: page === 1 ? '<https://api.github.test/comments?page=2>; rel="next"' : undefined,
      },
    }));
    const connector = new GitHubConnector(connectorConfig());
    const received: InboundMessage[] = [];
    await listenOnce(
      connector,
      (message) => {
        received.push(message);
      },
      {
        checkpoint: {
          version: 1,
          repos: {
            [REPO]: {
              lastPollAt: '2026-08-14T11:59:00.000Z',
              lastEtag: 'legacy-first-page-etag',
              processedCommentIds: Array.from({ length: 101 }, (_, index) => index + 1),
            },
          },
        },
      }
    );

    expect(received.map(({ providerEventId }) => providerEventId)).toEqual([
      'github:issue_comment:IC_102',
    ]);
    expect(githubApi.listCommentsForRepo.mock.calls.map(([request]) => request.page)).toEqual([
      1, 2,
    ]);
    expect(
      githubApi.listCommentsForRepo.mock.calls.every(([request]) => !('headers' in request))
    ).toBe(true);
  });

  it('does not rewind a standalone listener behind its startup cursor', async () => {
    const connector = new GitHubConnector(connectorConfig());

    const checkpoint = await listenOnce(connector, undefined, {
      durableEventIdempotency: false,
    });

    expect(checkpoint).toMatchObject({
      repos: {
        [REPO]: {
          lastPollAt: '2026-08-14T12:00:00.000Z',
        },
      },
    });
  });

  it('does not expose provider errors or external identities in operational logs', async () => {
    const sensitiveLogin = 'sensitive-github-login';
    const sensitiveError = 'sensitive-provider-response';
    githubApi.listCommentsForRepo.mockResolvedValue({
      data: [issueComment(9, { user: { login: sensitiveLogin, type: 'User' } })],
      headers: { etag: 'identity-etag' },
    });
    githubApi.getByUsername.mockRejectedValue(new Error(sensitiveError));
    const connector = new GitHubConnector(connectorConfig({ align_github_users: true }));

    await listenOnce(connector);

    const output = [console.log, console.warn, console.error]
      .flatMap((method) => vi.mocked(method).mock.calls)
      .flat()
      .join(' ');
    expect(output).toContain('event="user_lookup_failed"');
    expect(output).not.toContain(sensitiveLogin);
    expect(output).not.toContain(sensitiveError);
    expect(output).not.toContain(REPO);
  });
});

describe('GitHubConnector outbound comments', () => {
  it('updates an acknowledgement when its comment id is available', async () => {
    const connector = new GitHubConnector(connectorConfig());

    const result = await connector.sendMessage({
      threadId: 'preset-io/agor#42',
      text: 'final answer',
      metadata: { edit_comment_id: 900 },
    });

    expect(githubApi.updateComment).toHaveBeenCalledWith({
      owner: 'preset-io',
      repo: 'agor',
      comment_id: 900,
      body: 'final answer',
    });
    expect(githubApi.createComment).not.toHaveBeenCalled();
    expect(result).toBe('900');
  });

  it('creates a comment when there is no acknowledgement to update', async () => {
    githubApi.createComment.mockResolvedValue({ data: { id: 901 } });
    const connector = new GitHubConnector(connectorConfig());

    const result = await connector.sendMessage({
      threadId: 'preset-io/agor#42',
      text: 'standalone answer',
    });

    expect(githubApi.createComment).toHaveBeenCalledWith({
      owner: 'preset-io',
      repo: 'agor',
      issue_number: 42,
      body: 'standalone answer',
    });
    expect(result).toBe('901');
  });
});
