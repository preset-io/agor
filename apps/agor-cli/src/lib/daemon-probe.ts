export interface AgorDaemonProbe {
  running: boolean;
  managedInstanceId?: string;
}

/** A successful HTTP response alone is not proof that the configured port belongs to Agor. */
export async function probeAgorDaemon(url: string): Promise<AgorDaemonProbe> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return { running: false };
    const body = (await response.json()) as Record<string, unknown>;
    // `service` is the current unambiguous marker. The structural fallback is
    // required during reinstall so a new CLI can still recognize an older
    // Agor daemon that predates that marker.
    const auth = body.auth as Record<string, unknown> | undefined;
    const db = body.db as Record<string, unknown> | undefined;
    const isLegacyAgorHealth =
      typeof body.version === 'string' &&
      auth?.requireAuth === true &&
      typeof db?.ok === 'boolean' &&
      typeof body.timestamp === 'number';
    if (body.service !== 'agor-daemon' && !isLegacyAgorHealth) return { running: false };
    return {
      running: true,
      ...(typeof body.managedInstanceId === 'string'
        ? { managedInstanceId: body.managedInstanceId }
        : {}),
    };
  } catch {
    return { running: false };
  }
}

export async function isExpectedManagedDaemon(url: string, instanceId?: string): Promise<boolean> {
  if (!instanceId) return false;
  const probe = await probeAgorDaemon(url);
  return probe.running && probe.managedInstanceId === instanceId;
}
