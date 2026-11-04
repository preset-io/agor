/** Small HTTP client for the daemon's raw `.agorpack` routes. */

export class PackHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'PackHttpError';
  }
}

async function failure(response: Response): Promise<PackHttpError> {
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    message = body.error ?? body.message ?? message;
  } catch {
    // Non-JSON error body; keep the status line.
  }
  return new PackHttpError(message, response.status);
}

export async function packFetch(
  daemonUrl: string,
  bearer: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const response = await fetch(`${daemonUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${bearer}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw await failure(response);
  return response;
}

export async function packJson<T>(
  daemonUrl: string,
  bearer: string,
  path: string,
  body?: unknown
): Promise<T> {
  const response = await packFetch(daemonUrl, bearer, path, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
  return (await response.json()) as T;
}
