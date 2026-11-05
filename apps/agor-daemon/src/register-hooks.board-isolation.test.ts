import {
  BoardCommentsRepository,
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  CardRepository,
  createTenantScopedDatabaseProxy,
  GroupRepository,
  generateId,
  RepoRepository,
  shortId,
  UserApiKeysRepository,
  UsersRepository,
} from '@agor/core/db';
import { type BoardID, type CardID, toShortId, type UserID } from '@agor/core/types';
import { io as createSocketClient } from 'socket.io-client';
import { expect } from 'vitest';
import { dbTest } from '../../../packages/core/src/db/test-helpers.js';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import type { RegisterHooksContext } from './register-hooks.js';
import { createBoardCommentsService } from './services/board-comments.js';
import { createCardTypesService } from './services/card-types.js';
import { createCardsService } from './services/cards.js';

const ZONE = {
  type: 'zone' as const,
  x: 0,
  y: 0,
  width: 400,
  height: 400,
  label: 'Review',
};

dbTest(
  'MCP board reads follow board_access and every board mutation requires Board Editor',
  async ({ db: rawDb }) => {
    const users = new UsersRepository(rawDb);
    const owner = await users.create({ email: 'owner@example.test', role: 'member' });
    const member = await users.create({ email: 'member@example.test', role: 'member' });
    const editor = await users.create({ email: 'editor@example.test', role: 'member' });
    const admin = await users.create({ email: 'admin@example.test', role: 'admin' });
    const groupEditor = await users.create({ email: 'group-editor@example.test', role: 'member' });
    const groups = new GroupRepository(rawDb);
    const editors = await groups.create({ name: 'Board editors' });
    await groups.addMember(editors.group_id, groupEditor.user_id);
    const boards = new BoardRepository(rawDb);
    // Stored policy private: only the owner can view.
    const hidden = await boards.create({
      name: 'Hidden',
      created_by: owner.user_id,
      access_mode: 'private',
    });
    // Stored policy shared: Others are Viewers, one named Editor.
    const shared = await boards.create({ name: 'Shared', created_by: owner.user_id });
    const policies = new CapabilityPolicyRepository(rawDb);
    const sharedPolicy = await policies.getBoardPolicies(shared.board_id);
    await policies.replaceBoardPolicies(
      shared.board_id,
      {
        ...sharedPolicy,
        board_access: {
          ...sharedPolicy.board_access,
          entries: [
            {
              entry_id: generateId(),
              principal: { principal_type: 'user', user_id: editor.user_id },
              preset: 'editor',
              capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
              fs_access: 'none',
            },
            {
              entry_id: generateId(),
              principal: { principal_type: 'group', group_id: editors.group_id },
              preset: 'editor',
              capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
              fs_access: 'none',
            },
          ],
        },
      },
      owner.user_id
    );
    for (const board of [hidden, shared]) {
      await boards.upsertBoardObject(board.board_id, 'zone-a', ZONE);
      await boards.upsertBoardObject(board.board_id, 'zone-b', { ...ZONE, x: 500 });
    }
    const cards = new CardRepository(rawDb);
    const placements = new BoardObjectRepository(rawDb);
    const seedCard = async (boardId: BoardID, title: string) => {
      const card = await cards.create({ board_id: boardId, title, created_by: owner.user_id });
      await placements.create({
        board_id: boardId,
        card_id: card.card_id,
        position: { x: 1, y: 1 },
      });
      return card.card_id as CardID;
    };
    const hiddenCard = await seedCard(hidden.board_id, 'Hidden card');
    const sharedCard = await seedCard(shared.board_id, 'Shared card');

    const keys = new UserApiKeysRepository(rawDb);
    const keyFor = async (userId: UserID) => (await keys.create(userId, 'disposable test')).rawKey;
    const ownerKey = await keyFor(owner.user_id as UserID);
    const memberKey = await keyFor(member.user_id as UserID);
    const editorKey = await keyFor(editor.user_id as UserID);
    const adminKey = await keyFor(admin.user_id as UserID);
    const groupEditorKey = await keyFor(groupEditor.user_id as UserID);
    const workspaceViewer = await users.create({ email: 'ws-viewer@example.test', role: 'viewer' });
    const workspaceViewerKey = await keyFor(workspaceViewer.user_id as UserID);
    // Others are Editors here, so only the workspace role can stop a mutation.
    const open = await boards.create({ name: 'Open', created_by: owner.user_id });
    const openPolicy = await policies.getBoardPolicies(open.board_id);
    await policies.replaceBoardPolicies(
      open.board_id,
      {
        ...openPolicy,
        board_access: {
          ...openPolicy.board_access,
          others: {
            preset: 'editor',
            capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
            fs_access: 'none',
          },
        },
      },
      owner.user_id
    );
    const openCard = await seedCard(open.board_id, 'Open card');

    const db = createTenantScopedDatabaseProxy(rawDb, { label: 'board-isolation-test' });
    const server = await boardMetadataTestApp(
      db,
      {
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'board-isolation-test' },
        execution: {},
      } as RegisterHooksContext['config'],
      false,
      true,
      false,
      async (app) => {
        app.use('card-types', createCardTypesService(db));
        app.use('cards', createCardsService(db));
      }
    );
    const call = async (key: string, name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'X-API-Key': key,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const parsed = JSON.parse(
        text
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6) ?? text
      );
      expect(parsed.error).toBeUndefined();
      const result = parsed.result as { isError?: boolean; content: { text: string }[] };
      return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
    };
    const ok = async (key: string, name: string, args: Record<string, unknown>) => {
      const result = await call(key, name, args);
      expect(result.isError, `${name} ${result.text}`).toBe(false);
      return JSON.parse(result.text);
    };
    const denied = async (key: string, name: string, args: Record<string, unknown>) => {
      const result = await call(key, name, args);
      expect(result.isError, `${name} unexpectedly succeeded: ${result.text}`).toBe(true);
    };
    const cardCount = async (boardId: string) =>
      (await cards.findByBoardId(boardId as BoardID)).length;
    const placementOf = async (cardId: CardID) => placements.findByCardId(cardId);

    try {
      // Reads follow the stored board_access policy, not the legacy row fields.
      const listed = await ok(memberKey, 'agor_boards_list', {});
      const listedIds = listed.data.map((board: { board_id: string }) => board.board_id);
      expect(listedIds).toContain(shared.board_id);
      expect(listedIds).not.toContain(hidden.board_id);
      await denied(memberKey, 'agor_boards_get', { boardId: hidden.board_id });
      await denied(memberKey, 'agor_cards_get', { cardId: hiddenCard });
      const sharedRead = await ok(memberKey, 'agor_boards_get', { boardId: shared.board_id });
      expect(sharedRead.permissions.board_access.others.preset).toBe('viewer');
      expect((await ok(memberKey, 'agor_cards_get', { cardId: sharedCard })).card_id).toBe(
        sharedCard
      );
      // Hidden, missing and ambiguous board IDs give the same answer and never name hidden boards.
      for (const boardId of [hidden.board_id, toShortId(hidden.board_id, 4), generateId()]) {
        const result = await call(memberKey, 'agor_boards_get', { boardId });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('Board not found');
        expect(result.text).toContain(`Board not found: ${boardId}`);
        if (boardId !== hidden.board_id) expect(result.text).not.toContain(hidden.board_id);
      }
      // Short IDs resolve only among visible cards, so ambiguity errors never name hidden ones.
      for (const name of ['agor_cards_get', 'agor_cards_archive', 'agor_cards_unarchive']) {
        expect(
          (await call(memberKey, name, { cardId: toShortId(hiddenCard, 4) })).text
        ).not.toContain(hiddenCard);
      }

      // A Viewer (and a non-viewer) cannot change board content through any tool.
      for (const boardId of [shared.board_id, hidden.board_id]) {
        await denied(memberKey, 'agor_cards_create', { boardId, title: 'Planted' });
        await denied(memberKey, 'agor_cards_bulk_create', {
          boardId,
          cards: [{ title: 'Planted' }],
        });
        await denied(memberKey, 'agor_boards_update', {
          boardId,
          upsertObjects: { planted: { ...ZONE, label: 'Planted' } },
        });
        await denied(memberKey, 'agor_boards_update', { boardId, removeObjects: ['zone-a'] });
        expect(await cardCount(boardId)).toBe(1);
        const board = await boards.findById(boardId);
        expect(board?.objects?.planted).toBeUndefined();
        expect(board?.objects?.['zone-a']).toBeDefined();
      }
      for (const cardId of [sharedCard, hiddenCard]) {
        await denied(memberKey, 'agor_cards_archive', { cardId });
        await denied(memberKey, 'agor_cards_unarchive', { cardId });
        await denied(memberKey, 'agor_cards_move', { cardId, zoneId: 'zone-b' });
        await denied(memberKey, 'agor_cards_bulk_move', { moves: [{ cardId, zoneId: 'zone-b' }] });
        await denied(memberKey, 'agor_cards_move', { cardId, zoneId: null });
        await denied(memberKey, 'agor_cards_set_position', { cardId, x: 99, y: 99 });
        await denied(memberKey, 'agor_cards_update', { cardId, title: 'Renamed' });
        await denied(memberKey, 'agor_cards_delete', { cardId });
        expect((await cards.findById(cardId))?.archived).toBe(false);
        expect(await placementOf(cardId)).toMatchObject({ position: { x: 1, y: 1 } });
        expect((await placementOf(cardId))?.zone_id).toBeUndefined();
      }
      await denied(memberKey, 'agor_boards_archive', { boardId: shared.board_id });

      // A slug that is another board's ID prefix authorizes and writes the same (own) board.
      const decoy = await ok(memberKey, 'agor_boards_create', {
        name: 'Decoy',
        slug: shortId(hidden.board_id),
      });
      expect(decoy.slug).toBe(shortId(hidden.board_id));
      await ok(memberKey, 'agor_boards_update', {
        boardId: decoy.slug,
        name: 'Decoy renamed',
        upsertObjects: { planted: { ...ZONE, label: 'Planted' } },
        removeObjects: ['zone-a'],
      });
      await ok(memberKey, 'agor_boards_archive', { boardId: decoy.slug });
      const hiddenAfter = await boards.findById(hidden.board_id);
      expect(hiddenAfter).toMatchObject({ name: 'Hidden', archived: false });
      expect(hiddenAfter?.objects?.planted).toBeUndefined();
      expect(hiddenAfter?.objects?.['zone-a']).toBeDefined();
      expect(await boards.findById(decoy.board_id)).toMatchObject({
        name: 'Decoy renamed',
        archived: true,
      });

      // A slug equal to a board's full ID never shadows that board for its legitimate editors.
      const shadow = await ok(memberKey, 'agor_boards_create', {
        name: 'Shadow',
        slug: shared.board_id,
      });
      expect(shadow.slug).toBe(shared.board_id);
      expect((await ok(editorKey, 'agor_boards_get', { boardId: shared.board_id })).board_id).toBe(
        shared.board_id
      );
      await ok(editorKey, 'agor_boards_update', {
        boardId: shared.board_id,
        name: 'Shared renamed',
        upsertObjects: { note: { ...ZONE, label: 'Note' } },
      });
      await ok(editorKey, 'agor_boards_update', {
        boardId: shared.board_id,
        removeObjects: ['note'],
      });
      expect(await boards.findById(shared.board_id)).toMatchObject({ name: 'Shared renamed' });
      const shadowAfter = await boards.findById(shadow.board_id);
      expect(shadowAfter?.name).toBe('Shadow');
      expect(shadowAfter?.objects?.note).toBeUndefined();

      // Board grants do not lift a workspace viewer above the Member floor for card writes.
      await denied(workspaceViewerKey, 'agor_cards_create', {
        boardId: open.board_id,
        title: 'No',
      });
      await denied(workspaceViewerKey, 'agor_cards_archive', { cardId: openCard });
      await denied(workspaceViewerKey, 'agor_cards_move', { cardId: openCard, zoneId: null });
      expect(await cardCount(open.board_id)).toBe(1);
      expect((await ok(workspaceViewerKey, 'agor_cards_get', { cardId: openCard })).card_id).toBe(
        openCard
      );

      // An allowed object write publishes exactly one patched board event.
      const patched: unknown[] = [];
      server.app.service('boards').on('patched', (board: unknown) => patched.push(board));
      await ok(editorKey, 'agor_boards_update', {
        boardId: shared.board_id,
        upsertObjects: { once: { ...ZONE, label: 'Once' } },
      });
      expect(patched).toHaveLength(1);
      await ok(editorKey, 'agor_boards_update', {
        boardId: shared.board_id,
        removeObjects: ['once'],
      });
      expect(patched).toHaveLength(2);

      // Board Editors, owners, and admins keep full board content access.
      for (const [key, boardId, cardId] of [
        [editorKey, shared.board_id, sharedCard],
        [groupEditorKey, shared.board_id, sharedCard],
        [ownerKey, hidden.board_id, hiddenCard],
        [adminKey, hidden.board_id, hiddenCard],
      ] as const) {
        expect((await ok(key, 'agor_cards_get', { cardId })).card_id).toBe(cardId);
        await ok(key, 'agor_cards_create', { boardId, title: 'Legit', zoneId: 'zone-a' });
        await ok(key, 'agor_cards_bulk_create', { boardId, cards: [{ title: 'Legit bulk' }] });
        await ok(key, 'agor_boards_update', {
          boardId,
          upsertObjects: { legit: { ...ZONE, label: 'Legit' } },
        });
        await ok(key, 'agor_boards_update', { boardId, removeObjects: ['legit'] });
        expect((await boards.findById(boardId))?.objects?.legit).toBeUndefined();
        await ok(key, 'agor_cards_archive', { cardId });
        await ok(key, 'agor_cards_unarchive', { cardId });
        await ok(key, 'agor_cards_move', { cardId, zoneId: 'zone-b' });
        expect((await placementOf(cardId))?.zone_id).toBe('zone-b');
        await ok(key, 'agor_cards_bulk_move', { moves: [{ cardId, zoneId: null }] });
        expect((await placementOf(cardId))?.zone_id).toBeUndefined();
        await ok(key, 'agor_cards_set_position', { cardId, x: 7, y: 8 });
        expect(await placementOf(cardId)).toMatchObject({ position: { x: 7, y: 8 } });
      }
    } finally {
      await server.close();
    }
  },
  60000
);

dbTest(
  'MCP board creation stores the requested board visibility and reports the stored policy',
  async ({ db: rawDb }) => {
    const users = new UsersRepository(rawDb);
    const creator = await users.create({ email: 'creator@example.test', role: 'member' });
    const other = await users.create({ email: 'other@example.test', role: 'member' });
    const keys = new UserApiKeysRepository(rawDb);
    const creatorKey = (await keys.create(creator.user_id, 'disposable test')).rawKey;
    const otherKey = (await keys.create(other.user_id, 'disposable test')).rawKey;
    const db = createTenantScopedDatabaseProxy(rawDb, { label: 'board-create-test' });
    const server = await boardMetadataTestApp(
      db,
      {
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'board-create-test' },
        execution: {},
      } as RegisterHooksContext['config'],
      false,
      true
    );
    const call = async (key: string, name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'X-API-Key': key,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const text = await response.text();
      const parsed = JSON.parse(
        text
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6) ?? text
      );
      return parsed.result as { isError?: boolean; content: { text: string }[] };
    };
    const policies = new CapabilityPolicyRepository(rawDb);
    try {
      const privateResult = await call(creatorKey, 'agor_boards_create', {
        name: 'Private via MCP',
        accessMode: 'private',
        defaultOthersCan: 'none',
      });
      expect(privateResult.isError).not.toBe(true);
      const privateBoard = JSON.parse(privateResult.content[0].text);
      const stored = await policies.getBoardPolicies(privateBoard.board_id);
      expect(stored.board_access).toMatchObject({
        sharing_mode: 'private',
        others: { preset: 'none' },
      });
      expect(privateBoard.permissions.board_access).toMatchObject({
        sharing_mode: 'private',
        others: { preset: 'none' },
      });
      expect(
        (await call(otherKey, 'agor_boards_get', { boardId: privateBoard.board_id })).isError
      ).toBe(true);

      // defaultOthersCan is the default branch permission; the response shows the stored board policy.
      const sharedResult = await call(creatorKey, 'agor_boards_create', {
        name: 'Shared via MCP',
        defaultOthersCan: 'none',
      });
      const sharedBoard = JSON.parse(sharedResult.content[0].text);
      expect(sharedBoard.permissions).toMatchObject({
        board_access: { sharing_mode: 'shared', others: { preset: 'viewer' } },
        branch_template: { access: { others: { preset: 'none' } } },
      });
      expect(sharedBoard).not.toHaveProperty('access_mode');
      expect(sharedBoard).not.toHaveProperty('default_others_can');
    } finally {
      await server.close();
    }
  },
  30000
);

dbTest(
  'Socket.IO array IDs cannot reach a hidden card or comment through an editable board',
  async ({ db: rawDb }) => {
    const users = new UsersRepository(rawDb);
    const owner = await users.create({ email: 'sock-owner@example.test', role: 'member' });
    const member = await users.create({ email: 'sock-member@example.test', role: 'member' });
    const boards = new BoardRepository(rawDb);
    const hidden = await boards.create({
      name: 'Hidden',
      created_by: owner.user_id,
      access_mode: 'private',
    });
    const editable = await boards.create({ name: 'Mine', created_by: member.user_id });
    const cards = new CardRepository(rawDb);
    const hiddenCard = await cards.create({
      board_id: hidden.board_id,
      title: 'Secret',
      created_by: owner.user_id,
    });
    const comments = new BoardCommentsRepository(rawDb);
    const hiddenComment = await comments.create({
      board_id: hidden.board_id,
      created_by: member.user_id,
      content: 'Secret comment',
    });
    const db = createTenantScopedDatabaseProxy(rawDb, { label: 'board-isolation-socket-test' });
    const server = await boardMetadataTestApp(
      db,
      {
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'board-isolation-socket-test' },
        execution: {},
      } as RegisterHooksContext['config'],
      true,
      false,
      false,
      async (app) => {
        app.use('card-types', createCardTypesService(db));
        app.use('cards', createCardsService(db));
        app.use('board-comments', createBoardCommentsService(db));
      }
    );
    const token = server.headers(member.user_id as UserID).authorization.slice(7);
    const socket = createSocketClient(server.url, {
      transports: ['websocket'],
      forceNew: true,
      auth: { token },
    });
    const emit = (...args: unknown[]) =>
      new Promise<{ error?: { message?: string }; result?: unknown }>((resolve) => {
        socket.emit(...(args as [string]), (error: { message?: string } | null, result: unknown) =>
          resolve({ error: error ?? undefined, result })
        );
      });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      const attempts: unknown[][] = [
        [
          'patch',
          'cards',
          [hiddenCard.card_id],
          { board_id: editable.board_id, title: 'Tampered' },
          {},
        ],
        [
          'update',
          'cards',
          [hiddenCard.card_id],
          { board_id: editable.board_id, title: 'Tampered' },
          {},
        ],
        ['get', 'cards', [hiddenCard.card_id], {}],
        ['remove', 'cards', [hiddenCard.card_id], {}],
        ['patch', 'cards', { card_id: hiddenCard.card_id }, { board_id: editable.board_id }, {}],
        ['get', 'board-comments', [hiddenComment.comment_id], {}],
        ['patch', 'board-comments', [hiddenComment.comment_id], { content: 'Tampered' }, {}],
        ['remove', 'board-comments', [hiddenComment.comment_id], {}],
      ];
      for (const attempt of attempts) {
        const { error, result } = await emit(...attempt);
        // Rejected as malformed before any record hook or adapter sees the array/object.
        expect(
          error,
          `${attempt[0]} ${attempt[1]} returned ${JSON.stringify(result)}`
        ).toMatchObject({
          name: 'BadRequest',
          message: 'Resource ID must be a single string',
        });
        expect(JSON.stringify(result ?? null)).not.toContain('Secret');
      }
      expect(await cards.findById(hiddenCard.card_id)).toMatchObject({
        title: 'Secret',
        board_id: hidden.board_id,
      });
      expect((await comments.findById(hiddenComment.comment_id))?.content).toBe('Secret comment');
    } finally {
      socket.close();
      await server.close();
    }
  },
  30000
);

dbTest(
  'branch responses omit canvas fields from a board the viewer cannot see',
  async ({ db: rawDb }) => {
    const users = new UsersRepository(rawDb);
    const owner = await users.create({ email: 'zone-owner@example.test', role: 'member' });
    const viewer = await users.create({ email: 'zone-viewer@example.test', role: 'member' });
    const boards = new BoardRepository(rawDb);
    const hidden = await boards.create({
      name: 'Hidden',
      created_by: owner.user_id,
      access_mode: 'private',
    });
    await boards.upsertBoardObject(hidden.board_id, 'zone-secret', {
      ...ZONE,
      label: 'Secret zone',
    });
    const repo = await new RepoRepository(rawDb).create({
      repo_type: 'remote',
      remote_url: 'https://example.test/zone-fixture.git',
      slug: 'zone-fixture',
      local_path: '/tmp/zone-fixture',
      default_branch: 'main',
    });
    // The branch itself is shared with Others as Viewers; its board is not.
    const branch = await new BranchRepository(rawDb).create({
      repo_id: repo.repo_id,
      board_id: hidden.board_id,
      name: 'visible-branch',
      ref: 'visible-branch',
      branch_unique_id: 1,
      created_by: owner.user_id,
      primary_owner_user_id: owner.user_id,
      permission_source: 'override',
      others_can: 'view',
    });
    await new BoardObjectRepository(rawDb).create({
      board_id: hidden.board_id,
      branch_id: branch.branch_id,
      position: { x: 3, y: 4 },
      zone_id: 'zone-secret',
    });
    const db = createTenantScopedDatabaseProxy(rawDb, { label: 'branch-zone-test' });
    const server = await boardMetadataTestApp(db, {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'branch-zone-test' },
      execution: {},
    } as RegisterHooksContext['config']);
    const read = async (userId: string, path: string) => {
      const response = await fetch(`${server.url}${path}`, {
        headers: server.headers(userId as UserID),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      expect((await read(owner.user_id, `/boards/${hidden.board_id}`)).board_id).toBe(
        hidden.board_id
      );
      expect(await read(owner.user_id, `/branches/${branch.branch_id}`)).toMatchObject({
        zone_id: 'zone-secret',
        zone_label: 'Secret zone',
        position: { x: 3, y: 4 },
      });
      const seen = await read(viewer.user_id, `/branches/${branch.branch_id}`);
      expect(seen.branch_id).toBe(branch.branch_id);
      for (const field of ['board_object_id', 'position', 'zone_id', 'zone_label']) {
        expect(seen).not.toHaveProperty(field);
      }
      const listed = await read(viewer.user_id, '/branches');
      const rows = Array.isArray(listed) ? listed : listed.data;
      const row = rows.find(
        (candidate: { branch_id: string }) => candidate.branch_id === branch.branch_id
      );
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('zone_label');
    } finally {
      await server.close();
    }
  },
  30000
);
