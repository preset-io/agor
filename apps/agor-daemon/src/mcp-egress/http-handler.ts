import type { Request, Response } from 'express';
import { type MCPEgressGateway, MCPEgressGatewayError } from './gateway.js';

/** The production Express boundary for mediated MCP provider requests. */
export function createMCPEgressHttpHandler(
  gateway: Pick<MCPEgressGateway, 'forward'> &
    Partial<Pick<MCPEgressGateway, 'recordRejectedRequest'>>
) {
  return async (req: Request, res: Response): Promise<void> => {
    let gatewayHeaders: Headers | undefined;
    try {
      const parsedHeaders = new Headers();
      for (const [name, rawValue] of Object.entries(req.headers)) {
        if (typeof rawValue === 'string') parsedHeaders.set(name, rawValue);
        else if (Array.isArray(rawValue)) parsedHeaders.set(name, rawValue.join(', '));
      }
      gatewayHeaders = parsedHeaders;
      const serverId = String(req.params.serverId ?? '');
      const body =
        req.body == null
          ? undefined
          : req.body instanceof Uint8Array
            ? new Uint8Array(req.body)
            : new TextEncoder().encode(
                typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
              );
      const forwarded = await gateway.forward({
        serverId,
        headers: gatewayHeaders,
        method: req.method,
        body,
      });
      res.status(forwarded.response.status);
      forwarded.response.headers.forEach((value, name) => {
        res.setHeader(name, value);
      });
      res.end(Buffer.from(await forwarded.response.arrayBuffer()));
    } catch (error) {
      const gatewayError =
        error instanceof MCPEgressGatewayError
          ? error
          : new MCPEgressGatewayError(
              503,
              'egress_unavailable',
              'MCP gateway egress is temporarily unavailable',
              'ambiguous'
            );
      const safeServerId = String(req.params.serverId ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
      console.warn(
        `[MCP Egress] event=request_rejected server_id=${safeServerId || '<invalid>'} code=${gatewayError.code}`
      );
      // Recovery projection must never delay the provider-facing rejection:
      // the authority snapshot that produced this error may still hold a
      // SQLite writer transaction until the caller observes the response.
      const recoveryProjection = gatewayHeaders
        ? gateway.recordRejectedRequest?.(
            gatewayHeaders,
            String(req.params.serverId ?? ''),
            gatewayError
          )
        : undefined;
      if (recoveryProjection) {
        void recoveryProjection.catch(() => {
          console.warn('[MCP Egress] event=recovery_projection_failed');
        });
      }
      if (!res.headersSent) {
        const id =
          req.body && typeof req.body === 'object' && 'id' in req.body
            ? (req.body as { id?: unknown }).id
            : null;
        res.status(gatewayError.status).json({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32003,
            message: gatewayError.message,
            data: {
              code: gatewayError.code,
              provider_dispatch: gatewayError.dispatch,
              automatic_retry_allowed: false,
            },
          },
        });
      } else {
        res.end();
      }
    }
  };
}
