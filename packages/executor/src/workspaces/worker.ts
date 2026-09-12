import {
  exportGitSeed,
  installGitSeed,
  LOCAL_HOME_DIRECTORIES,
  LOCAL_TOOL_ENV,
} from './local-environment.js';
import { withWorkspacePreparation } from './preparation.js';
import { isQuiescentSdkTree, SDK_PROCESS_COLUMNS } from './quiescence.js';
import { copyClaudeTranscripts, importClaudeSession } from './sdk-transcripts.js';
/** Trusted controller process. Never mounted into or executed as an SDK child. */

import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chown, lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { availableParallelism, totalmem } from 'node:os';
import path from 'node:path';
import type { BranchID, TenantID } from '@agor/core/types';
import {
  BranchWorkspaceCoordinator,
  hash,
  included,
  type WorkspaceOptions,
} from '@agor/core/workspaces';
import { z } from 'zod';
import { browseBranchFiles, readBranchFile } from '../commands/files.js';
import { buildFileResults } from '../commands/git.js';
import {
  BranchFilesBrowsePayloadSchema,
  BranchFilesListPayloadSchema,
  BranchFilesReadPayloadSchema,
  PromptPayloadSchema,
} from '../payload-types.js';
import { connectWorkspaceAuthority } from './connection.js';
import { S3WorkspaceBlobs } from './s3-blobs.js';
import { WorkerSqlAuthority } from './sql-authority.js';

const Config = z.object({
  databaseUrl: z.string(),
  databaseIamAuth: z.boolean().default(false),
  region: z.string().default('ap-southeast-2'),
  sslCaPath: z.string(),
  bucket: z.string(),
  root: z.string(),
  origin: z.string().url(),
  controlToken: z.string().min(32),
  image: z.string(),
  toolMemoryGiB: z.number().int().min(1).max(64).default(8),
  toolCpus: z.number().min(0.5).max(64).default(2),
  port: z.number().default(8787),
  maximumSessions: z.number().int().positive().default(2),
  daemonUrl: z.string().url(),
  managedToolsRoot: z.string(),
  sourceHome: z.string(),
  executorEntry: z.string(),
  clone: z.enum(['copy', 'reflink']).default('reflink'),
});
const Dispatch = z.object({
  tenantId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  branchId: z.string().uuid(),
  payload: PromptPayloadSchema,
});
const Execute = z.object({
  command: z.string().min(1).max(65536),
  timeout_ms: z.number().int().min(1000).max(900000),
  idempotencyKey: z.string().uuid(),
});
type DispatchInput = z.infer<typeof Dispatch>;

async function ownTree(root: string, signal?: AbortSignal, skipLocal = false): Promise<void> {
  signal?.throwIfAborted();
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) return;
  if (skipLocal && stat.isDirectory() && stat.uid === 1000 && !included(path.basename(root), []))
    return;
  if (stat.uid !== 1000 || stat.gid !== 1000) await chown(root, 1000, 1000);
  if (stat.isDirectory())
    for (const name of await readdir(root)) await ownTree(path.join(root, name), signal, skipLocal);
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function authorized(req: IncomingMessage, key: string): boolean {
  const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(key);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

export async function startWorker(configPath: string) {
  const config = Config.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const sql = await connectWorkspaceAuthority(config);
  const host = `${config.origin}#${randomUUID()}`;
  const options: WorkspaceOptions = {
    root: config.root,
    host,
    clone: config.clone,
    leaseMs: 60000,
    toolLeaseMs: 3600000,
    maximumBytes: 20 * 1024 ** 3,
    maximumFiles: 250000,
    minimumFreeBytes: 5 * 1024 ** 3,
    minimumFreeInodes: 100000,
    maximumActiveTools: 16,
    maximumReceipts: 10000,
    exclude: [],
    observe: (metric, context) =>
      console.log(JSON.stringify({ event: 'workspace', ...metric, ...context })),
  };
  const coordinators = new Map<string, BranchWorkspaceCoordinator>();
  const jobs = new Map<
    string,
    {
      input: DispatchInput;
      coordinator: BranchWorkspaceCoordinator;
      workspace: string;
      localHome: string;
      queue: Promise<unknown>;
      stopping: boolean;
      outcomes: Map<string, { request: string; result: Promise<unknown> }>;
      containers: Set<string>;
      finalize: () => Promise<void>;
    }
  >();
  function coordinator(tenantId: string, branchId: string, slot = 'code') {
    const key = `${tenantId}/${branchId}/${slot}`;
    let c = coordinators.get(key);
    if (!c) {
      const scope = { tenantId: tenantId as TenantID, branchId: branchId as BranchID };
      c = new BranchWorkspaceCoordinator(
        scope,
        new WorkerSqlAuthority(sql, scope, slot),
        new S3WorkspaceBlobs(config.bucket, scope.tenantId),
        {
          ...options,
          root: slot === 'code' ? config.root : path.join(config.root, 'sdk', hash(slot)),
        }
      );
      coordinators.set(key, c);
    }
    return c;
  }
  async function docker(args: string[], input?: string, timeout = 120000, output?: ServerResponse) {
    return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let captured = '';
      const onData = (chunk: Buffer) => {
        if (output) output.write(chunk);
        else if (captured.length < 1024 * 1024)
          captured += chunk.toString().slice(0, 1024 * 1024 - captured.length);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 137, output: captured });
      });
      child.stdin.end(input);
    });
  }
  async function removeContainer(name: string) {
    const result = await docker(['rm', '-f', name]);
    if (result.exitCode !== 0) {
      const remaining = await docker([
        'container',
        'ls',
        '-a',
        '--filter',
        `name=^/${name}$`,
        '--format',
        '{{.ID}}',
      ]);
      if (remaining.exitCode !== 0 || remaining.output.trim())
        throw new Error('Container quiescence could not be verified');
    }
  }
  const containerBase = (name: string, tool = false) => [
    'run',
    '--name',
    name,
    '--init',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    tool ? `${config.toolMemoryGiB}g` : '3g',
    '--cpus',
    tool ? String(config.toolCpus) : '1',
    '--add-host',
    'host.docker.internal:host-gateway',
  ];
  async function execute(capability: string, data: z.infer<typeof Execute>) {
    const job = jobs.get(capability);
    if (!job || job.stopping) throw new Error('Expired or stopped workspace capability');
    const previous = job.outcomes.get(data.idempotencyKey);
    const request = JSON.stringify(data);
    if (previous) {
      if (previous.request !== request)
        throw new Error('Idempotency key reused for a different command');
      return previous.result;
    }
    const operation = job.queue.then(async () => {
      const checkAuthority = async () => {
        const result = await fetch(`${config.daemonUrl}/tasks/${job.input.payload.params.taskId}`, {
          headers: { authorization: `Bearer ${job.input.payload.sessionToken}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!result.ok) throw new Error('Task authority expired or revoked');
        const task = (await result.json()) as { termination_request?: unknown; status: string };
        if (job.stopping || !['running', 'awaiting_permission'].includes(task.status))
          throw new Error('Task is no longer authorized to execute tools');
        if (task.termination_request) throw new Error('Task termination requested');
      };
      await checkAuthority();
      const c = job.coordinator;
      const tool = await c.beginTool(
        job.input.payload.params.sessionId,
        data.idempotencyKey,
        data.idempotencyKey
      );
      await ownTree(tool.workspace, undefined, true);
      const name = `agor-tool-${randomUUID()}`;
      job.containers.add(name);
      try {
        const result = await docker(
          [
            ...containerBase(name, true),
            ...LOCAL_HOME_DIRECTORIES.flatMap((directory) => [
              '-v',
              `${job.localHome}/${directory}:/home/agor/${directory}`,
            ]),
            ...LOCAL_TOOL_ENV.flatMap((value) => ['-e', value]),
            '-v',
            `${tool.workspace}:/workspace${job.input.payload.params.principalBranchAccess === 'write' ? '' : ':ro'}`,
            '-w',
            '/workspace',
            '--entrypoint',
            '/bin/bash',
            config.image,
            '-o',
            'pipefail',
            '-c',
            data.command,
          ],
          undefined,
          data.timeout_ms
        );
        const state = await docker(['inspect', '--format', '{{.State.OOMKilled}}', name]);
        if (state.exitCode !== 0) throw new Error('Unable to verify tool resource outcome');
        if (state.output.trim() === 'true') {
          result.exitCode = 137;
          result.output += '\nAgor: tool exceeded its memory limit (OOM killed).\n';
        }
        // docker run can return while detached descendants remain; destroy the
        // entire container namespace BEFORE examining or publishing mutations.
        await removeContainer(name);
        job.containers.delete(name);
        await checkAuthority();
        const outcome = await c.completeTool(tool.ticket);
        return {
          ...result,
          outcome,
          baseRevision: tool.ticket.baseRevision,
          toolId: tool.ticket.toolId,
        };
      } catch (error) {
        await removeContainer(name);
        job.containers.delete(name);
        await c.abortTool(tool.ticket).catch(() => {});
        throw error;
      }
    });
    job.outcomes.set(data.idempotencyKey, { request, result: operation });
    job.queue = operation.catch(() => {});
    return operation;
  }
  const gitSeeds = new Map<string, Promise<string>>();
  function gitSeed(tenantId: string, branchId: string, sourcePath: string, signal: AbortSignal) {
    const key = `${tenantId}/${branchId}`;
    let pending = gitSeeds.get(key);
    if (!pending) {
      pending = (async () => {
        const gitState = coordinator(tenantId, branchId, 'git-seed');
        const seed = path.join(config.root, 'git-seeds', randomUUID());
        try {
          if (!(await gitState.metadata.read()).state) {
            const source = await realpath(sourcePath);
            if (!source.startsWith(`${await realpath(config.sourceHome)}/`))
              throw new Error('Git source outside configured Agor home');
            await exportGitSeed(source, seed);
          }
          await gitState.materialise(seed, signal);
          const id = randomUUID();
          const replica = await gitState.beginTool('seed', id, id, signal);
          await gitState.completeTool(replica.ticket);
          await gitState.drain();
          return replica.workspace;
        } finally {
          await rm(seed, { recursive: true, force: true });
        }
      })();
      gitSeeds.set(key, pending);
      void pending.catch(() => gitSeeds.delete(key));
    }
    return pending;
  }
  async function dispatch(
    input: DispatchInput,
    res: ServerResponse,
    signal: AbortSignal,
    handoff: () => void
  ) {
    if (input.payload.params.tool !== 'claude-code')
      throw new Error('Only Claude Code supports this replicated execution adapter');
    const { tenantId, branchId, payload } = input;
    if (!['read', 'write'].includes(payload.params.principalBranchAccess ?? 'none'))
      throw new Error('Branch filesystem access denied');
    // Resolve parent binding through the daemon using the existing scoped task
    // token. Caller-supplied ids/paths alone are not sufficient authorization.
    const sessionResponse = await fetch(
      `${config.daemonUrl}/sessions/${payload.params.sessionId}`,
      { headers: { authorization: `Bearer ${payload.sessionToken}` } }
    );
    if (!sessionResponse.ok) throw new Error('Session authority rejected');
    const session = (await sessionResponse.json()) as {
      branch_id: string;
      sdk_session_id?: string;
      genealogy?: { forked_from_session_id?: string };
    };
    const claims = JSON.parse(
      Buffer.from(payload.sessionToken.split('.')[1], 'base64url').toString()
    ) as Record<string, unknown>;
    if (
      claims.tenant_id !== tenantId ||
      claims.branch_id !== branchId ||
      claims.task_id !== payload.params.taskId
    )
      throw new Error('Authenticated executor authority scope mismatch');
    if (session.branch_id !== branchId) throw new Error('Session/branch mismatch');
    const c = coordinator(tenantId, branchId);
    const placement = await c.metadata.read();
    if (
      placement.state?.host &&
      placement.state.host !== host &&
      placement.state.leaseUntil > placement.now
    )
      return json(res, 409, { owner: placement.state.host.split('#')[0] });
    const branchResponse = await fetch(`${config.daemonUrl}/branches/${branchId}`, {
      headers: { authorization: `Bearer ${payload.sessionToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!branchResponse.ok) throw new Error('Branch authority rejected');
    const branch = (await branchResponse.json()) as { path: string };
    if (branch.path !== payload.params.cwd)
      throw new Error('Initial source differs from authorized branch');
    const source = placement.state ? undefined : await realpath(branch.path);
    if (source && !source.startsWith(`${await realpath(config.sourceHome)}/`))
      throw new Error('Initial source outside configured Agor home');
    await c.materialise(source, signal);
    signal.throwIfAborted();
    let preparationLeaseError: unknown;
    const preparationRenewal = setInterval(() => {
      void c.renew().catch((error) => {
        preparationLeaseError ??= error;
      });
    }, 10000);
    try {
      const initial = await c.beginTool(
        payload.params.sessionId,
        `initial-${payload.params.taskId}`,
        `initial-${payload.params.taskId}`,
        signal
      );
      await c.completeTool(initial.ticket);
      signal.throwIfAborted();
      await installGitSeed(
        await gitSeed(tenantId, branchId, branch.path, signal),
        initial.workspace,
        config.clone
      );
      await ownTree(initial.workspace, signal, true);
      const localHome = path.join(path.dirname(initial.workspace), 'local-home');
      for (const directory of LOCAL_HOME_DIRECTORIES) {
        const location = path.join(localHome, directory);
        await mkdir(location, { recursive: true, mode: 0o700 });
        await chown(location, 1000, 1000);
      }
      const sdk = coordinator(tenantId, branchId, `claude/${payload.params.sessionId}`);
      const seed = path.join(config.root, 'sdk-seeds', randomUUID());
      await mkdir(seed, { recursive: true, mode: 0o700 });
      if (!(await sdk.metadata.read()).state) {
        let resumeId = session.sdk_session_id;
        let fromSession = payload.params.sessionId;
        if (!resumeId && session.genealogy?.forked_from_session_id) {
          fromSession = session.genealogy.forked_from_session_id;
          const parentResponse = await fetch(`${config.daemonUrl}/sessions/${fromSession}`, {
            headers: { authorization: `Bearer ${payload.sessionToken}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!parentResponse.ok) throw new Error('Fork parent authority rejected');
          const parent = (await parentResponse.json()) as {
            branch_id: string;
            sdk_session_id?: string;
          };
          if (parent.branch_id !== branchId)
            throw new Error('Cross-branch transcript import requires explicit migration');
          resumeId = parent.sdk_session_id;
        }
        if (resumeId) {
          const parentState = await coordinator(
            tenantId,
            branchId,
            `claude/${fromSession}`
          ).metadata.read();
          if (parentState.state) {
            // Read the immutable committed transcript tree without taking the
            // parent's lease or touching an active parent's local files.
            const { render } = await import('@agor/core/workspaces');
            await rm(seed, { recursive: true });
            await render(
              seed,
              parentState.state.tree,
              new S3WorkspaceBlobs(config.bucket, tenantId as TenantID),
              []
            );
          } else {
            const legacyHome =
              payload.env?.CLAUDE_CONFIG_DIR ?? path.join(config.sourceHome, '.claude');
            if (!legacyHome)
              throw new Error(
                'Resumable session has no durable transcript; explicit legacy SDK home required'
              );
            const canonicalHome = await realpath(legacyHome);
            if (!canonicalHome.startsWith(`${await realpath(config.sourceHome)}/`))
              throw new Error('Legacy SDK home outside authorized data root');
            await importClaudeSession(canonicalHome, seed, resumeId);
          }
        }
      }
      try {
        await sdk.materialise(seed, signal);
      } finally {
        await rm(seed, { recursive: true, force: true });
      }
      const sdkTicket = await sdk.beginTool(
        'session',
        payload.params.taskId,
        payload.params.taskId
      );
      const sdkHome = path.join(path.dirname(sdkTicket.workspace), `live-${randomUUID()}`);
      await mkdir(sdkHome, { mode: 0o700 });
      await copyClaudeTranscripts(sdkTicket.workspace, sdkHome);
      await ownTree(sdkHome, signal);
      signal.throwIfAborted();
      const capability = randomUUID() + randomUUID();
      const job = {
        input,
        coordinator: c,
        workspace: initial.workspace,
        localHome,
        queue: Promise.resolve() as Promise<unknown>,
        stopping: false,
        outcomes: new Map<string, { request: string; result: Promise<unknown> }>(),
        containers: new Set<string>(),
        finalize: async (): Promise<void> => {
          throw new Error('Session not ready');
        },
      };
      jobs.set(capability, job);
      const name = `agor-sdk-${payload.params.taskId}`;
      job.containers.add(name);
      let fenced = false;
      let finalized = false;
      let finalization: Promise<void> | undefined;
      const finalize = async () => {
        if (finalized) return;
        job.stopping = true;
        await job.queue;
        const processes = await docker(['top', name, '-eo', SDK_PROCESS_COLUMNS]);
        if (!isQuiescentSdkTree(processes.exitCode, processes.output))
          throw new Error('SDK descendants are still running; transcript snapshot refused');
        if (fenced) throw new Error('SDK host was fenced');
        for (const item of await readdir(sdkTicket.workspace))
          await rm(path.join(sdkTicket.workspace, item), { recursive: true, force: true });
        await copyClaudeTranscripts(sdkHome, sdkTicket.workspace);
        const outcome = await sdk.completeTool(sdkTicket.ticket);
        if (outcome.status !== 'committed') throw new Error('SDK transcript publication conflict');
        finalized = true;
        await sdk.drain();
      };
      job.finalize = () => (finalization ??= finalize());
      const renewal = setInterval(() => {
        void Promise.all([
          c.renew(),
          ...(finalized
            ? []
            : [
                sdk.renew().catch((error) => {
                  if (!finalized) throw error;
                }),
              ]),
        ]).catch(async () => {
          fenced = true;
          for (const container of job.containers)
            await removeContainer(container).catch((error) =>
              console.error('Containment failed', String(error))
            );
        });
      }, 10000);
      res.writeHead(200, { 'content-type': 'text/plain' });
      try {
        const forwarded = {
          ...payload,
          daemonUrl: config.daemonUrl,
          replicatedWorkspace: {
            endpoint: `http://host.docker.internal:${config.port}`,
            capability,
            cwd: '/workspace',
          },
          env: {
            ...payload.env,
            CLAUDE_CONFIG_DIR: '/home/agor/.claude',
            AGOR_AGENTIC_TOOLS_DIR: '/opt/agentic-tools',
            AGOR_MANAGED_AGENTIC_TOOLS: '1',
          },
        };
        // Cloud authority never enters the SDK container, even if the daemon's
        // inherited environment accidentally contains an AWS or SQL credential.
        for (const key of Object.keys(forwarded.env))
          if (/^(AWS_|DATABASE_URL$|PGPASSWORD$)/.test(key))
            delete forwarded.env[key as keyof typeof forwarded.env];
        signal.throwIfAborted();
        if (preparationLeaseError) throw preparationLeaseError;
        clearInterval(preparationRenewal);
        handoff();
        await docker(
          [
            ...containerBase(name),
            '-i',
            '-v',
            `${initial.workspace}:/workspace:ro`,
            '-v',
            `${sdkHome}:/home/agor/.claude`,
            '-v',
            `${config.managedToolsRoot}:/opt/agentic-tools:ro`,
            '-w',
            '/workspace',
            '--entrypoint',
            'node',
            config.image,
            config.executorEntry,
            '--stdin',
          ],
          JSON.stringify(forwarded),
          3600000,
          res
        );
        await removeContainer(name);
        job.containers.delete(name);
        await job.queue;
        if (fenced) throw new Error('SDK host was fenced');
        if (!finalized) throw new Error('Executor exited without durable SDK finalization');
        await c
          .checkpoint()
          .catch((error) => console.warn('Idle checkpoint deferred', String(error)));
        res.end();
      } catch (error) {
        await sdk.abortTool(sdkTicket.ticket).catch(() => {});
        if (signal.aborted) throw error;
        res.end(`\nWorkspace failure: ${String(error)}\n`);
      } finally {
        clearInterval(renewal);
        jobs.delete(capability);
        for (const container of job.containers) await removeContainer(container);
      }
    } finally {
      clearInterval(preparationRenewal);
    }
  }
  async function readCommand(raw: unknown) {
    const input = z
      .object({
        tenantId: z.string().regex(/^[A-Za-z0-9_-]+$/),
        branchId: z.string().uuid(),
        payload: z.union([
          BranchFilesBrowsePayloadSchema,
          BranchFilesReadPayloadSchema,
          BranchFilesListPayloadSchema,
        ]),
        access: z.enum(['read', 'write']),
      })
      .parse(raw);
    const { tenantId, branchId, payload } = input;
    if (payload.params.branchId !== branchId) throw new Error('Command branch scope mismatch');
    const response = await fetch(`${config.daemonUrl}/branches/${branchId}`, {
      headers: { authorization: `Bearer ${payload.sessionToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Command branch authority rejected');
    const claims = JSON.parse(
      Buffer.from(payload.sessionToken.split('.')[1], 'base64url').toString()
    );
    if (claims.tenant_id !== tenantId || claims.branch_id !== branchId)
      throw new Error('Command tenant/branch scope mismatch');
    const c = coordinator(tenantId, branchId);
    if (!(await c.metadata.read()).state) throw new Error('Branch not adopted');
    await c.materialise();
    const id = randomUUID();
    const tool = await c.beginTool(`read-${id}`, id, id);
    try {
      let data: unknown;
      if (payload.command === 'branch.files.read')
        data = { file: await readBranchFile(tool.workspace, payload.params.filePath) };
      else {
        const files = await browseBranchFiles(tool.workspace);
        data =
          payload.command === 'branch.files.browse'
            ? { files }
            : {
                branchId,
                results: buildFileResults(
                  files.map((f) => f.path).join('\0'),
                  payload.params.search,
                  payload.params.limit
                ),
              };
      }
      return { success: true, data };
    } finally {
      await c.abortTool(tool.ticket);
    }
  }
  let reservations = 0;
  const maximumSessions = Math.min(
    config.maximumSessions,
    Math.floor(availableParallelism() / (config.toolCpus + 1)),
    Math.floor((totalmem() - 2 * 1024 ** 3) / ((config.toolMemoryGiB + 3) * 1024 ** 3))
  );
  const activeSessions = new Set<string>();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health')
        return json(res, 200, { status: 'ok', host });
      if (req.method === 'POST' && req.url === '/quiesce') {
        const capability = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        const job = jobs.get(capability);
        if (!job) return json(res, 403, { error: 'Invalid capability' });
        job.stopping = true;
        for (const name of job.containers)
          if (name.startsWith('agor-tool-')) await removeContainer(name);
        await job.queue;
        await job.finalize();
        return json(res, 200, { quiescent: true });
      }
      if (req.method === 'POST' && req.url === '/finalize') {
        const capability = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        const job = jobs.get(capability);
        if (!job) return json(res, 403, { error: 'Invalid capability' });
        await job.finalize();
        return json(res, 200, { durable: true });
      }
      if (req.method === 'POST' && req.url === '/execute') {
        const capability = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        if (!jobs.has(capability)) return json(res, 403, { error: 'Invalid capability' });
        return json(res, 200, await execute(capability, Execute.parse(await body(req))));
      }
      if (!authorized(req, config.controlToken))
        return json(res, 403, { error: 'Unauthorized controller' });
      if (req.method === 'POST' && req.url === '/read-command')
        return json(res, 200, await readCommand(await body(req)));
      if (req.method === 'POST' && req.url === '/dispatch') {
        if (reservations >= maximumSessions) {
          console.warn(
            JSON.stringify({
              event: 'workspace_admission_rejected',
              reason: 'cpu_memory_reservations',
              reservations,
              maximumSessions,
            })
          );
          return json(res, 429, { error: 'Worker CPU/memory admission capacity exhausted' });
        }
        const input = Dispatch.parse(await body(req));
        const sessionKey = `${input.tenantId}/${input.branchId}/${input.payload.params.sessionId}`;
        if (activeSessions.has(sessionKey))
          return json(res, 409, { error: 'Session already active' });
        activeSessions.add(sessionKey);
        reservations++;
        try {
          await withWorkspacePreparation(
            config.daemonUrl,
            input.payload.sessionToken,
            input.payload.params.taskId,
            (signal, handoff) => dispatch(input, res, signal, handoff)
          );
          if (!res.writableEnded) res.end();
          return;
        } finally {
          reservations--;
          activeSessions.delete(sessionKey);
        }
      }
      if (req.method === 'POST' && req.url === '/placement') {
        const scope = z
          .object({ tenantId: z.string().regex(/^[A-Za-z0-9_-]+$/), branchId: z.string().uuid() })
          .parse(await body(req));
        const { state, now } = await coordinator(scope.tenantId, scope.branchId).metadata.read();
        return json(res, 200, {
          owner: state?.host && state.leaseUntil > now ? state.host.split('#')[0] : null,
          revision: state?.revision ?? null,
        });
      }
      if (req.method === 'POST' && req.url === '/drain') {
        if (jobs.size) return json(res, 409, { error: 'SDK sessions active' });
        for (const c of coordinators.values()) {
          const { state } = await c.metadata.read();
          if (state?.host === host) await c.drain();
        }
        return json(res, 200, { drained: true });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) json(res, 409, { error: String(error) });
      else res.end();
    }
  });
  server.listen(config.port, '0.0.0.0');
  console.log(JSON.stringify({ event: 'workspace_worker_ready', host, port: config.port }));
  return { server, sql };
}
