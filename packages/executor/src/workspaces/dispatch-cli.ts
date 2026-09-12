/** Existing executor template transport. Control credentials never enter SDK containers. */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ExecutorResponsePublisher } from '../executor-response.js';
import type { ExecutorResult } from '../payload-types.js';

const config = z
  .object({
    workers: z.array(z.string().url()).min(1),
    controlToken: z.string().min(32),
    executorEntry: z.string(),
    branchReflinkRoot: z.string().optional(),
  })
  .parse(JSON.parse(await readFile(process.argv[2], 'utf8')));
const tenantId = process.argv[3];
if (!tenantId || !/^[A-Za-z0-9_-]+$/.test(tenantId))
  throw new Error('Trusted tenant argument required');
const trustedBranch = process.argv[4];
const access = process.argv[5];
const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 4 * 1024 * 1024) throw new Error('Executor payload too large');
  chunks.push(chunk);
}
const raw = Buffer.concat(chunks).toString();
const payload = JSON.parse(raw);
const claims = payload.sessionToken
  ? JSON.parse(Buffer.from(payload.sessionToken.split('.')[1], 'base64url').toString())
  : {};
const branchCandidate = trustedBranch || payload.params?.branchId || claims.branch_id;
const branchId = branchCandidate ? z.string().uuid().parse(branchCandidate) : undefined;
const headers = {
  authorization: `Bearer ${config.controlToken}`,
  'content-type': 'application/json',
};
let selected: string | undefined;
let adopted = false;
if (branchId) {
  for (const worker of config.workers) {
    try {
      const response = await fetch(`${worker}/placement`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tenantId, branchId }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const placement = (await response.json()) as {
        owner: string | null;
        revision: number | null;
      };
      if (placement.owner && !config.workers.includes(placement.owner))
        throw new Error('Unknown workspace owner');
      selected = placement.owner ?? worker;
      adopted = placement.revision !== null;
      break;
    } catch {
      /* Another reachable host can inspect the durable authority. */
    }
  }
  if (!selected)
    throw new Error('No workspace authority reachable; stale checkout fallback refused');
}
if (payload.command === 'prompt' && payload.requiresReplicatedWorkspace) {
  if (!selected || !branchId) throw new Error('Replicated dispatch scope missing');
  // Never retry an uncertain dispatch: the original task may already be running.
  const response = await fetch(`${selected}/dispatch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId, branchId, payload }),
  });
  if (!response.ok)
    throw new Error(
      `Workspace dispatch rejected (${response.status}): ${(await response.text()).slice(0, 2048)}`
    );
  if (!response.body) throw new Error('Workspace dispatch response missing');
  for await (const chunk of response.body) process.stdout.write(chunk);
} else if (adopted) {
  let result: ExecutorResult;
  if (['branch.files.list', 'branch.files.read', 'branch.files.browse'].includes(payload.command)) {
    const response = await fetch(`${selected}/read-command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenantId,
        branchId,
        payload,
        access: access || payload.params?.principalBranchAccess,
      }),
    });
    result = response.ok
      ? ((await response.json()) as ExecutorResult)
      : {
          success: false,
          error: { code: 'WORKSPACE_READ_FAILED', message: (await response.text()).slice(0, 2048) },
        };
  } else {
    result = {
      success: false,
      error: {
        code: 'WORKSPACE_COMMAND_UNSUPPORTED',
        message: `${payload.command} is not yet supported on replicated branches; stale checkout execution was refused. Use the managed Claude workspace tool for code changes.`,
      },
    };
  }
  if (payload.executorResponse)
    await new ExecutorResponsePublisher(payload.executorResponse).final(result);
  process.exitCode = result.success ? 0 : 1;
} else {
  const child = spawn(process.execPath, [config.executorEntry, '--stdin'], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, AGOR_BRANCH_REFLINK_ROOT: config.branchReflinkRoot ?? '' },
  });
  child.stdin.end(raw);
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
