/**
 * `MCPServerConfig` takes positional arguments only, and `excludeTools` sits in
 * the 14th slot behind a run of options Agor never sets. Funnelling every
 * transport branch through one keyword-argument builder keeps the call sites
 * readable and the padding in exactly one place.
 *
 * SAFETY: this padding is load-bearing and fails OPEN. Slot 13 is
 * `includeTools`, an allowlist. If the SDK inserts a parameter anywhere ahead
 * of `excludeTools`, Agor's deny list slides into it and turns into "permit
 * ONLY the tools the user switched off" — everything else on the server
 * allowed. Nothing here can catch that: the constructor is typed
 * `new (...args: never[]) => T` and cast to `unknown[]`, so `tsc` checks
 * neither arity nor position. `mcp-server-config.test.ts` pins the order
 * against the SDK's shipped `config.d.ts`; keep that test passing rather than
 * adjusting it to match a new signature by hand.
 */
export function buildGeminiMcpServerConfig<T>(
  MCPServerConfig: new (...args: never[]) => T,
  options: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    httpUrl?: string;
    headers?: Record<string, string>;
    excludeTools: string[];
  }
): T {
  const ctor = MCPServerConfig as unknown as new (...args: unknown[]) => T;
  return new ctor(
    options.command,
    options.args,
    options.env,
    options.cwd,
    options.url,
    options.httpUrl,
    options.headers,
    undefined, // tcp
    undefined, // type
    undefined, // timeout
    undefined, // trust
    undefined, // description
    undefined, // includeTools
    options.excludeTools.length > 0 ? options.excludeTools : undefined
  );
}
