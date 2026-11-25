import { describe, expect, it } from 'vitest';
import type { MCPServer } from '../types';
import {
  activeSessionMcpServers,
  mcpServerConfigWarning,
  type ResolveSessionMcpEntriesInput,
  readHiddenMcpServerIds,
  resolveSessionMcpEntries,
} from './effective-set';

function server(id: string, overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    mcp_server_id: id,
    name: id,
    scope: 'global',
    enabled: true,
    transport: 'http',
    ...overrides,
  } as MCPServer;
}

const open = server('open');
const perUser = server('per-user', { auth: { type: 'oauth', oauth_mode: 'per_user' } });
const shared = server('shared', { auth: { type: 'oauth', oauth_mode: 'shared' } });
const machine = server('machine', {
  auth: { type: 'oauth', oauth_mode: 'per_user', oauth_grant_type: 'client_credentials' },
});
const linked = server('linked', { scope: 'session' });

function resolve(input: Partial<ResolveSessionMcpEntriesInput<MCPServer>> = {}) {
  const entries = resolveSessionMcpEntries({
    links: [],
    linkedServers: [],
    globalServers: [open, perUser, shared, machine],
    connectedServerIds: new Set(),
    forUserId: 'user-a',
    ...input,
  });
  return Object.fromEntries(entries.map((entry) => [entry.server.mcp_server_id, entry.state]));
}

describe('resolveSessionMcpEntries', () => {
  it('loads an unconnected per-user OAuth global server only as a connect row', () => {
    expect(resolve()).toEqual({ open: 'active', 'per-user': 'needs_connect', shared: 'active' });
  });

  it('turns a per-user OAuth global server on once the user has connected it', () => {
    expect(resolve({ connectedServerIds: new Set(['per-user']) })['per-user']).toBe('active');
  });

  it('honours a per-session opt-out (disabled link) of a global server', () => {
    const states = resolve({
      links: [{ mcp_server_id: 'open', enabled: false }],
      linkedServers: [open],
      connectedServerIds: new Set(['per-user']),
    });
    expect(states.open).toBe('off');
    expect(states['per-user']).toBe('active');
  });

  it('hides only connect rows the user hid', () => {
    const hidden = new Set(['per-user', 'open']);
    expect(resolve({ hiddenServerIds: hidden })).toMatchObject({
      'per-user': 'hidden',
      open: 'active',
    });
    expect(
      resolve({ hiddenServerIds: hidden, connectedServerIds: new Set(['per-user']) })['per-user']
    ).toBe('active');
  });

  it('keeps enabled session links and lets an enabled link override a hidden global', () => {
    const states = resolve({
      links: [
        { mcp_server_id: 'linked', enabled: true },
        { mcp_server_id: 'per-user', enabled: true },
      ],
      linkedServers: [linked, perUser],
      hiddenServerIds: new Set(['per-user']),
    });
    expect(states).toMatchObject({ linked: 'active', 'per-user': 'active' });
  });

  it('drops disabled session-scoped links and lists globals as off for explicit selections', () => {
    expect(
      resolve({
        selectionExplicit: true,
        links: [{ mcp_server_id: 'linked', enabled: false }],
        linkedServers: [linked],
      })
    ).toEqual({ open: 'off', 'per-user': 'off', shared: 'off' });
  });

  it('never includes another user’s private server', () => {
    const foreign = server('foreign', { owner_user_id: 'user-b' } as Partial<MCPServer>);
    expect(resolve({ globalServers: [foreign] })).toEqual({});
  });

  it('answers membership only for scope checks: connection and config warnings ignored', () => {
    expect(
      resolve({
        membershipOnly: true,
        links: [{ mcp_server_id: 'open', enabled: false }],
        linkedServers: [open],
      })
    ).toEqual({ open: 'off', 'per-user': 'active', shared: 'active', machine: 'active' });
    expect(resolve({ membershipOnly: true, selectionExplicit: true }).machine).toBe('off');
  });

  it('feeds the runtime only active servers', () => {
    const entries = resolveSessionMcpEntries({
      links: [],
      linkedServers: [],
      globalServers: [open, perUser],
      connectedServerIds: new Set(),
      forUserId: 'user-a',
    });
    expect(activeSessionMcpServers(entries)).toEqual([open]);
  });
});

describe('mcpServerConfigWarning', () => {
  it('flags per-user OAuth with the client_credentials grant only', () => {
    expect(mcpServerConfigWarning(machine)).toMatch(/cannot sign in/);
    expect(mcpServerConfigWarning(perUser)).toBeUndefined();
    expect(
      mcpServerConfigWarning(
        server('shared-machine', {
          auth: { type: 'oauth', oauth_mode: 'shared', oauth_grant_type: 'client_credentials' },
        })
      )
    ).toBeUndefined();
  });
});

describe('readHiddenMcpServerIds', () => {
  it('reads string ids and ignores malformed values', () => {
    expect([...readHiddenMcpServerIds({ hidden_mcp_server_ids: ['a', 3, 'b'] })]).toEqual([
      'a',
      'b',
    ]);
    expect(readHiddenMcpServerIds({ hidden_mcp_server_ids: 'a' }).size).toBe(0);
    expect(readHiddenMcpServerIds(undefined).size).toBe(0);
  });
});
