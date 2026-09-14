import type { Application } from '@agor/core/feathers';
import { BadRequest } from '@agor/core/feathers';
import type { RouteParams } from '../register-routes';

/** The HTTP route retains authentication; this service only renders and forwards. */
export function createSpawnPromptService(app: Application) {
  return {
    async create(
      data: {
        userPrompt?: string;
        /**
         * Permission mode for the *parent* session's prompt. The spawn
         * config's `permissionMode` (child's intended mode) is rendered into
         * the meta-prompt; this field governs how the parent prompt is sent.
         */
        parentPermissionMode?: import('@agor/core/types').PermissionMode;
        // Remaining fields are spawn-subsession context (incl. the *child*
        // session's permissionMode/modelConfig/etc) — see
        // `SpawnSubsessionContext` in @agor/core for the shape.
        [key: string]: unknown;
      },
      params: RouteParams
    ) {
      const id = params.route?.id;
      if (!id) throw new BadRequest('Session ID required');
      if (typeof data?.userPrompt !== 'string') {
        throw new BadRequest('userPrompt (string) is required');
      }

      const { renderSpawnSubsessionPrompt } = await import(
        '@agor/core/templates/spawn-subsession-template'
      );
      // Render the meta-prompt against the child-session config (the rest
      // of `data`). `parentPermissionMode` is intentionally excluded — it's
      // the parent's send-mode, not part of the template.
      const { parentPermissionMode, ...spawnContext } = data;
      const metaPrompt = renderSpawnSubsessionPrompt(
        spawnContext as unknown as import('@agor/core/templates/spawn-subsession-template').SpawnSubsessionContext
      );

      const promptService = app.service('/sessions/:id/prompt');
      return promptService.create(
        {
          prompt: metaPrompt,
          permissionMode: parentPermissionMode,
          messageSource: 'agor',
          metadata: { system_authored: true },
        },
        { ...params, provider: undefined, route: { id } }
      );
    },
  };
}
