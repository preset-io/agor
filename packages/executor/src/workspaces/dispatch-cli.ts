import path from 'node:path';
import { CachePolicy, type Candidate, choosePlacement } from './placement.js';
/** Existing executor template transport. Control credentials never enter SDK containers. */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ExecutorResponsePublisher } from '../executor-response.js';
import type { ExecutorResult } from '../payload-types.js';
import { recordDispatchRejection } from './dispatch-diagnostic.js';

const config = z
  .object({
    workers: z.array(z.string().url()).min(1),
    controlToken: z.string().min(32),
    executorEntry: z.string(),
    branchReflinkRoot: z.string().optional(),
    cachePolicy: CachePolicy.optional(),
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
  const started = Date.now();
  const policy = config.cachePolicy;
  do {
    const replies = await Promise.all(
      config.workers.map(async (worker) => {
        try {
          const response = await fetch(`${worker}/placement`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ tenantId, branchId, sourcePath: payload.params?.cwd }),
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) return undefined;
          return {
            worker,
            ...((await response.json()) as {
              owner: string | null;
              revision: number | null;
              sourceAvailable?: boolean;
              workers?: Candidate[];
            }),
          };
        } catch {
          return undefined;
        }
      })
    );
    const placements = replies.filter((p) => p !== undefined);
    const owners = new Set(placements.map((p) => p.owner).filter((p): p is string => !!p));
    if ([...owners].some((owner) => !config.workers.includes(owner)))
      throw new Error('Unknown workspace owner');
    if (owners.size > 1)
      throw new Error('Placement authority changed during lookup; retry before dispatch');
    const owner = [...owners][0] ?? null;
    adopted = placements.some((p) => p.revision !== null);
    if (!adopted && !(payload.command === 'prompt' && payload.requiresReplicatedWorkspace)) {
      selected = owner ?? placements[0]?.worker;
      break;
    }
    if (!policy) {
      selected = owner ?? placements[0]?.worker;
      break;
    }
    // Only a direct successful response makes an origin reachable; SQL heartbeats
    // alone never override an unreachable live owner or authorize dispatch retries.
    const candidates = new Map<string, Candidate>();
    for (const placement of placements)
      for (const candidate of placement.workers ?? []) {
        if (
          !config.workers.includes(candidate.origin) ||
          !placements.some((p) => p.worker === candidate.origin && (adopted || p.sourceAvailable))
        )
          continue;
        const old = candidates.get(candidate.origin);
        if (!old || candidate.ageMs < old.ageMs) candidates.set(candidate.origin, candidate);
      }
    const choice = choosePlacement({
      owner,
      workers: [...candidates.values()],
      tenantId,
      branchId,
      repository: path.dirname(payload.params?.cwd ?? branchId),
      sessionId: payload.params?.sessionId,
      waitedMs: Date.now() - started,
      policy,
    });
    console.error(
      JSON.stringify({
        event: 'workspace_placement',
        ...choice,
        branchId,
        waitedMs: Date.now() - started,
      })
    );
    selected = policy.mode === 'observe' ? (owner ?? placements[0]?.worker) : choice.origin;
    if (selected || Date.now() - started >= policy.affinityWaitMs) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, policy.affinityWaitMs - (Date.now() - started)))
    );
  } while (!selected);
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
  if (!response.ok) {
    const code = await recordDispatchRejection(
      response.status,
      await response.text(),
      payload.params?.taskId
    );
    throw new Error(`${code} (${response.status})`);
  }
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
