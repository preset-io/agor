import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Only closed error codes and schema paths enter this log; never payloads or tokens. */
export async function recordDispatchRejection(status: number, response: string, taskId: unknown) {
  let detail: unknown;
  try {
    detail = JSON.parse(response);
  } catch {
    detail = undefined;
  }
  const error = (detail as { error?: unknown } | undefined)?.error;
  const known = [
    'Session already active',
    'Worker CPU/memory admission capacity exhausted',
    'Error: Session authority rejected',
    'Error: Branch authority rejected',
    'Error: Session/branch mismatch',
    'Error: Authenticated executor authority scope mismatch',
    'Error: Initial source differs from authorized branch',
    'Error: Branch filesystem access denied',
  ];
  let issues: unknown;
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error);
      if (Array.isArray(parsed))
        issues = parsed.map(({ code, path }) => ({
          code: typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'unknown',
          path: Array.isArray(path)
            ? path.filter((part) => typeof part === 'string' && /^[a-zA-Z_]+$/.test(part))
            : [],
        }));
    } catch {
      /* No free-form error text in diagnostics. */
    }
  }
  const code =
    typeof error === 'string' && known.includes(error)
      ? error
      : issues
        ? 'Invalid workspace dispatch payload'
        : 'Workspace dispatch rejected';
  const directory = join(homedir(), '.agor', 'logs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(
    join(directory, 'workspace-dispatch.jsonl'),
    `${JSON.stringify({
      at: new Date().toISOString(),
      status,
      code,
      issues,
      taskId: typeof taskId === 'string' && /^[a-f0-9-]{36}$/.test(taskId) ? taskId : undefined,
    })}\n`,
    { mode: 0o600 }
  );
  return code;
}
