import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PreviewError, RailwayAPI, requireValue } from './api.mjs';
import { configuration } from './configuration.mjs';
import { Preview } from './preview.mjs';

export async function run(action, input, env = process.env, request = fetch) {
  requireValue(
    ['start', 'stop', 'logs', 'nuke', 'check'].includes(action),
    'Expected start, stop, logs, nuke or check.'
  );
  const config = configuration(env, input);
  const api = new RailwayAPI(env.RAILWAY_API_TOKEN, request);
  if (config.sharedProject) {
    const { project } = await api.query(
      'query PreviewProject($id:String!){project(id:$id){id workspaceId}}',
      { id: config.projectId }
    );
    requireValue(
      project?.id === config.projectId &&
        typeof project.workspaceId === 'string' &&
        /^[0-9a-f-]{36}$/i.test(project.workspaceId),
      'Railway project is inaccessible or has no workspace.'
    );
    config.workspaceId = project.workspaceId;
  }
  const preview = new Preview(api, config, input);
  let owned = await preview.inspect();
  if (action === 'check')
    return {
      message:
        'Railway authorization and ownership checks passed. No resources were created or started.',
    };
  if (action === 'start') {
    // Already running means no variable writes, rebuild or redeploy.
    if (owned.service && (await preview.active(owned)).length) return preview.running(owned);
    const password = env.RAILWAY_AGOR_ADMIN_PASSWORD;
    requireValue(
      password && [...password].length >= 15 && Buffer.byteLength(password, 'utf8') <= 72,
      'Save RAILWAY_AGOR_ADMIN_PASSWORD (15+ characters, at most 72 UTF-8 bytes) in secure Global variables.'
    );
    let sha;
    try {
      const response = await request(
        `https://api.github.com/repos/${input.repository}/git/ref/heads/${encodeURIComponent(input.ref)}`,
        { redirect: 'error', signal: AbortSignal.timeout(30_000) }
      );
      const body = response.ok ? await response.json() : null;
      if (
        body?.ref !== `refs/heads/${input.ref}` ||
        body.object?.type !== 'commit' ||
        !/^[a-f0-9]{40}$/.test(body.object.sha)
      )
        throw new Error();
      sha = body.object.sha;
    } catch {
      throw new PreviewError(
        'Cannot resolve the pushed public GitHub branch. Push it before Start; private source resolution is not supported.'
      );
    }
    owned = await preview.ensure(owned, password);
    return preview.start(owned, sha);
  }
  if (!owned.service)
    return { message: 'No owned service exists for this branch. Nothing was changed.' };
  if (action === 'logs') {
    const logs = await preview.logs(owned);
    let safe = logs;
    for (const value of Object.values(env).filter((v) => typeof v === 'string' && v.length >= 12))
      safe = safe.split(value).join('[REDACTED]');
    return {
      message: safe
        .replace(/^.*AGOR_ENVIRONMENT_RESULT=.*$/gm, '[control record omitted]')
        .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/g, '[REDACTED]')
        .slice(-24000),
    };
  }
  await preview.stop(owned);
  if (action === 'nuke') {
    await preview.remove(await preview.inspect());
    return { message: 'Owned preview removed. Its data was permanently deleted.' };
  }
  return { message: 'Compute stopped. Service and volume retained; storage charges still apply.' };
}

export async function main(args = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        binding: { type: 'string' },
        repository: { type: 'string' },
        ref: { type: 'string' },
      },
    });
  } catch {
    throw new PreviewError('Use --binding UUID --repository owner/repo --ref pushed-branch.');
  }
  requireValue(parsed.positionals.length === 1, 'Expected one lifecycle action.');
  const result = await run(parsed.positionals[0], parsed.values);
  if (result.app) console.log(`AGOR_ENVIRONMENT_RESULT=${JSON.stringify(result)}`);
  else console.log(result.message);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      error instanceof PreviewError
        ? error.message
        : 'Railway launcher failed; raw details withheld. Inspect provider state before retrying.'
    );
    process.exitCode = 1;
  });
}
