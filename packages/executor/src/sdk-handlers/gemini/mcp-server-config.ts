/**
 * `MCPServerConfig` takes positional arguments only, and `excludeTools` sits in
 * the 14th slot behind a run of options Agor never sets. Funnelling every
 * transport branch through one keyword-argument builder keeps the call sites
 * readable and the padding in exactly one place.
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
