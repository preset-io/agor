import { createTenantScopedDatabaseProxy, UserApiKeysRepository } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../packages/core/src/db/test-helpers.js';
import { seedBoardEntities } from '../test/board-entity-fixture.js';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import type { RegisterHooksContext } from './register-hooks.js';

dbTest(
  'real HTTP MCP direct/facade board reads and validation failures',
  async ({ db }) => {
    const fixture = await seedBoardEntities(db);
    const key = await new UserApiKeysRepository(db).create(
      fixture.owner.user_id,
      'disposable test'
    );
    const server = await boardMetadataTestApp(
      createTenantScopedDatabaseProxy(db),
      {
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'mcp-entity-audit' },
        execution: {},
      } as RegisterHooksContext['config'],
      false,
      true
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'X-API-Key': key.rawKey,
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
      return parsed.result as { isError?: boolean; content: { text: string }[] };
    };
    try {
      // These refinements are not represented by published JSON Schema keywords.
      // The facade's safe field/code error must lead to usable guidance.
      for (const toolName of ['agor_schedules_create', 'agor_schedules_patch']) {
        const details = JSON.parse(
          (await call('agor_get_tool_details', { tool_name: toolName })).content[0].text
        );
        expect(details.tool.inputSchema.properties.agentic_tool_config.description).toMatch(
          /Do not combine preset_id, configuration_reference, or inline fields \(permission_mode, model_config, context_files\)/
        );
      }
      const getBranch = vi.spyOn(server.app.service('branches'), 'get');
      const invalidConfig = await call('agor_execute_tool', {
        tool_name: 'agor_schedules_create',
        arguments: {
          branchId: fixture.entities[1].branch_id,
          name: 'Invalid configuration',
          cron_expression: '0 9 * * *',
          timezone_mode: 'utc',
          prompt: 'private-prompt-value',
          agentic_tool_config: {
            agentic_tool: 'codex',
            preset_id: 'private-preset-value',
            model_config: { model: 'private-model-value' },
          },
        },
      });
      expect(invalidConfig.isError).toBe(true);
      expect(JSON.parse(invalidConfig.content[0].text)).toMatchObject({
        code: 'invalid_tool_arguments',
        validation_stage: 'tool_input',
        issues: [{ field: 'agentic_tool_config', code: 'custom' }],
        hint: expect.stringContaining('agor_get_tool_details'),
      });
      expect(invalidConfig.content[0].text).not.toContain('private-');
      expect(getBranch).not.toHaveBeenCalled();
      getBranch.mockRestore();

      for (const toolName of ['agor_boards_list', 'agor_branches_list']) {
        const details = JSON.parse(
          (await call('agor_get_tool_details', { tool_name: toolName })).content[0].text
        );
        expect(details.tool.inputSchema.properties.offset.maximum).toBe(10000);
        const result = await call('agor_execute_tool', {
          tool_name: toolName,
          arguments: { offset: 10001 },
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          code: 'invalid_tool_arguments',
          issues: [{ field: 'offset', code: 'too_big' }],
        });
      }
      const boardDetails = JSON.parse(
        (await call('agor_get_tool_details', { tool_name: 'agor_boards_get' })).content[0].text
      );
      for (const field of ['entitiesLimit', 'entitiesSkip'])
        expect(boardDetails.tool.inputSchema.properties[field].maximum).toBe(10000);
      for (const facade of [false, true]) {
        const invoke = (args: Record<string, unknown>) =>
          facade
            ? call('agor_execute_tool', { tool_name: 'agor_boards_get', arguments: args })
            : call('agor_boards_get', args);
        const args = {
          boardId: fixture.board.board_id,
          includeEntities: true,
          entityZoneId: 'zone-review',
          entitiesLimit: 1,
          entitiesSkip: 1,
        };
        const result = await invoke(args);
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          entities: [{ object_id: fixture.entities[2].object_id }],
          entities_pagination: { total: 3, limit: 1, skip: 1 },
        });
        const find = vi.spyOn(server.app.service('board-objects'), 'find');
        const invalid = await invoke({ ...args, entitiesLimit: 'sensitive-invalid-value' });
        expect(invalid.isError).toBe(true);
        expect(find).not.toHaveBeenCalled();
        if (facade) {
          expect(JSON.parse(invalid.content[0].text)).toMatchObject({
            code: 'invalid_tool_arguments',
            validation_stage: 'tool_input',
            issues: [{ field: 'entitiesLimit', code: 'invalid_type' }],
          });
          expect(invalid.content[0].text).not.toContain('sensitive-invalid-value');
        }
        find.mockRestore();
      }
      // Simulated future service drift: both native and facade calls give the
      // same bounded diagnostic, not an instruction to blindly change caller IDs.
      server.app.service('board-objects').hooks({
        before: {
          find: [
            () => {
              throw new BadRequest('validation failed', [
                {
                  instancePath: '/branch_id/private-key',
                  keyword: 'type',
                  message: 'private-value',
                },
              ]);
            },
          ],
        },
      });
      for (const facade of [false, true]) {
        const args = { boardId: fixture.board.board_id, includeEntities: true };
        const result = facade
          ? await call('agor_execute_tool', { tool_name: 'agor_boards_get', arguments: args })
          : await call('agor_boards_get', args);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          code: 'service_validation_failed',
          validation_stage: 'service',
          retryable: false,
          issues: [{ field: 'branch_id', code: 'type' }],
        });
        expect(result.content[0].text).not.toContain('private-');
      }
    } finally {
      await server.close();
    }
  },
  30000
);
