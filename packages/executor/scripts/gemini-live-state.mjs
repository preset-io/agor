import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Use the installed release's repositories and schema, not a second transcript
// format. This fixture replaces daemon transport/auth, not agent execution or
// task completion. It has no connection to a user's daemon or database.
export async function openSmokeState(packageRoot, root) {
  const require = createRequire(join(packageRoot, 'package.json'));
  const core = await import(pathToFileURL(require.resolve('@agor/core/db')).href);
  const db = core.createDatabase({ url: `file:${join(root, 'state.db')}` });
  const repos = {
    users: new core.UsersRepository(db),
    repos: new core.RepoRepository(db),
    branches: new core.BranchRepository(db),
    sessions: new core.SessionRepository(db),
    tasks: new core.TaskRepository(db),
    messages: new core.MessagesRepository(db),
  };
  return {
    core,
    db,
    repos,
    close: () => db.$client.close(),
    client(apiKey) {
      return {
        service(name) {
          if (name === 'config/resolve-api-key')
            return {
              create: async () => ({ apiKey, source: 'environment', useNativeAuth: false }),
            };
          if (name === '/messages/streaming' || name === '/tasks/streaming')
            return { create: async () => ({}) };
          if (/^\/sessions\/[^/]+\/mcp-servers$/.test(name)) return { find: async () => [] };
          const repo = repos[name];
          if (!repo) throw new Error('Unsupported smoke service');
          return {
            get: (id) => repo.findById(id),
            create: (data) => repo.create(data),
            patch: (id, data) => repo.update(id, data),
            find: ({ query = {} } = {}) => {
              if (name !== 'messages') throw new Error('Unsupported smoke query');
              return repo.findPage({
                sessionId: query.session_id,
                taskId: query.task_id,
                role: query.role,
                sort: query.$sort,
                limit: query.$limit,
                select: query.$select,
              });
            },
          };
        },
      };
    },
  };
}
