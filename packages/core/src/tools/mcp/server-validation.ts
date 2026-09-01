import { isValidUUID } from '../../lib/ids';
import {
  containsTemplate,
  hasTemplateMarker,
  isValidMCPHttpUrlTemplate,
} from '../../mcp/template-patterns';
import { isCanonicalFullUuid } from '../../types/id';
import { MCP_SCOPES, MCP_TRANSPORTS, type MCPServer } from '../../types/mcp';
import { assertValidMCPAuthPatch } from './auth-patch';
import {
  findDuplicateMCPCustomHeaderName,
  isReservedMCPCustomHeaderName,
  isValidMCPHeaderName,
  MCP_HEADER_REDACTED_SENTINEL,
} from './http-headers';

const PUBLIC_CREATE_FIELDS = new Set([
  'name',
  'display_name',
  'description',
  'transport',
  'command',
  'args',
  'url',
  'headers',
  'env',
  'auth',
  'scope',
  'owner_user_id',
  'enabled',
]);

const TRUSTED_CREATE_FIELDS = new Set([
  ...PUBLIC_CREATE_FIELDS,
  'source',
  'import_path',
  'catalog_entry_name',
  'tools',
  'resources',
  'prompts',
  'tool_permissions',
]);

const PUBLIC_MUTATION_FIELDS = new Set([
  'display_name',
  'description',
  'transport',
  'command',
  'args',
  'url',
  'headers',
  'env',
  'auth',
  'scope',
  'enabled',
  'replace_auth',
  'expected_config_version',
  'tool_permissions',
]);

const TRUSTED_MUTATION_FIELDS = new Set([
  ...PUBLIC_MUTATION_FIELDS,
  'tools',
  'resources',
  'prompts',
]);

const MAX_NAME_LENGTH = 255;
const MAX_TEXT_LENGTH = 16_384;
const MAX_COLLECTION_ENTRIES = 256;
const MAX_VALUE_LENGTH = 65_536;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

/** MCP descriptions are protocol text and may legitimately be multiline. */
function hasUnsafeDescriptionControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code <= 31 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
}

export interface MCPServerWriteValidationOptions {
  operation: 'create' | 'mutation';
  /** Trusted daemon/catalog/import paths may set provenance and capabilities. */
  trusted: boolean;
  /** Public payloads reject fields that cannot apply to their stated transport. */
  enforceTransportCombination?: boolean;
  /** Existing/imported rows may retain historical provenance missing its optional evidence. */
  allowLegacyProvenance?: boolean;
  /** Public CREATE requires immediately usable bearer/JWT credentials. */
  requireConfiguredCredentials?: boolean;
}

/** Stable public-input failure carried through repository merge validation. */
export class MCPServerWriteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPServerWriteValidationError';
  }
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  options: { required?: boolean; max?: number; url?: boolean } = {}
): void {
  const value = record[field];
  if (value === undefined) {
    if (options.required) throw new Error(`${field} is required`);
    return;
  }
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if ((options.required || field !== 'description') && value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (value.length > (options.max ?? MAX_TEXT_LENGTH)) {
    throw new Error(`${field} is too long`);
  }
  if (hasControlCharacter(value)) throw new Error(`${field} contains control characters`);
  if (options.url) {
    if (value.includes('{{') || value.includes('}}')) {
      if (isValidMCPHttpUrlTemplate(value)) return;
      throw new Error(`${field} must be an HTTP(S) URL using only user.env templates`);
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${field} must be a valid HTTP(S) URL`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`${field} must be an HTTP(S) URL without embedded credentials`);
    }
  }
}

function stringArray(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ENTRIES) {
    throw new Error(`${field} must be an array of at most ${MAX_COLLECTION_ENTRIES} strings`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_VALUE_LENGTH || item.includes('\0')) {
      throw new Error(`${field} must contain only bounded strings without NUL characters`);
    }
  }
}

function stringMap(
  record: Record<string, unknown>,
  field: 'headers' | 'env',
  options: { allowSentinel?: boolean }
): void {
  const value = record[field];
  if (value === undefined) return;
  const map = recordOf(value, field);
  const entries = Object.entries(map);
  if (entries.length > MAX_COLLECTION_ENTRIES) {
    throw new Error(`${field} may contain at most ${MAX_COLLECTION_ENTRIES} entries`);
  }
  if (field === 'headers') {
    const duplicate = findDuplicateMCPCustomHeaderName(map);
    if (duplicate) {
      throw new Error(
        `Duplicate custom HTTP header names are not allowed: ${duplicate.first} and ${duplicate.duplicate}`
      );
    }
  }
  for (const [key, item] of entries) {
    if (!key || key.length > MAX_NAME_LENGTH || typeof item !== 'string') {
      throw new Error(`${field} must contain bounded string keys and values`);
    }
    if (item.length > MAX_VALUE_LENGTH || item.includes('\0')) {
      throw new Error(`${field}.${key} is too long or contains a NUL character`);
    }
    if (hasTemplateMarker(item) && !containsTemplate(item)) {
      throw new Error(`${field}.${key} contains an unbalanced template delimiter`);
    }
    if (!options.allowSentinel && item.trim() === MCP_HEADER_REDACTED_SENTINEL) {
      throw new Error(`${field}.${key} cannot use the redaction sentinel on create`);
    }
    if (field === 'headers' && (!isValidMCPHeaderName(key) || isReservedMCPCustomHeaderName(key))) {
      throw new Error(`headers.${key} is not an allowed custom HTTP header`);
    }
    if (field === 'env' && !ENV_NAME.test(key)) {
      throw new Error(`env.${key} is not a valid environment variable name`);
    }
  }
}

function toolPermissions(record: Record<string, unknown>): void {
  const value = record.tool_permissions;
  if (value === undefined) return;
  const permissions = recordOf(value, 'tool_permissions');
  if (Object.keys(permissions).length > MAX_COLLECTION_ENTRIES) {
    throw new Error(`tool_permissions may contain at most ${MAX_COLLECTION_ENTRIES} entries`);
  }
  for (const [name, permission] of Object.entries(permissions)) {
    if (
      !name ||
      name.length > MAX_NAME_LENGTH ||
      !['ask', 'allow', 'deny'].includes(String(permission))
    ) {
      throw new Error('tool_permissions must map bounded tool names to ask, allow, or deny');
    }
  }
}

function closedObject(value: unknown, label: string, allowed: readonly string[]) {
  const record = recordOf(value, label);
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
  return record;
}

function boundedRequiredString(
  record: Record<string, unknown>,
  field: string,
  label: string
): void {
  const value = record[field];
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_VALUE_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw new Error(`${label}.${field} must be a bounded non-empty string`);
  }
}

function boundedOptionalString(
  record: Record<string, unknown>,
  field: string,
  label: string
): void {
  const value = record[field];
  if (value === undefined) return;
  if (
    typeof value !== 'string' ||
    value.length > MAX_VALUE_LENGTH ||
    hasUnsafeDescriptionControlCharacter(value)
  ) {
    throw new Error(`${label}.${field} must be a bounded string`);
  }
}

function boundedJsonValue(value: unknown, label: string): void {
  let nodes = 0;
  const visit = (nested: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > 4096) throw new Error(`${label} is too large`);
    if (depth > 32) throw new Error(`${label} is too deeply nested`);
    if (
      nested === null ||
      typeof nested === 'boolean' ||
      (typeof nested === 'number' && Number.isFinite(nested))
    ) {
      return;
    }
    if (typeof nested === 'string') {
      if (nested.length > MAX_VALUE_LENGTH || hasControlCharacter(nested)) {
        throw new Error(`${path} contains an invalid string`);
      }
      return;
    }
    if (Array.isArray(nested)) {
      if (nested.length > MAX_COLLECTION_ENTRIES) throw new Error(`${path} is too large`);
      for (const [index, item] of nested.entries()) {
        visit(item, `${path}[${index}]`, depth + 1);
      }
      return;
    }
    const object = recordOf(nested, path);
    const entries = Object.entries(object);
    if (entries.length > MAX_COLLECTION_ENTRIES) throw new Error(`${path} is too large`);
    for (const [key, item] of entries) {
      if (!key || key.length > MAX_NAME_LENGTH || hasControlCharacter(key)) {
        throw new Error(`${path} contains an invalid key`);
      }
      visit(item, `${path}.${key}`, depth + 1);
    }
  };
  visit(value, label, 0);
}

function capabilities(record: Record<string, unknown>): void {
  if (record.tools !== undefined) {
    if (!Array.isArray(record.tools) || record.tools.length > MAX_COLLECTION_ENTRIES) {
      throw new Error(`tools must be an array of at most ${MAX_COLLECTION_ENTRIES} entries`);
    }
    for (const [index, value] of record.tools.entries()) {
      const tool = closedObject(value, `tools[${index}]`, ['name', 'description', 'input_schema']);
      boundedRequiredString(tool, 'name', `tools[${index}]`);
      boundedOptionalString(tool, 'description', `tools[${index}]`);
      if (tool.input_schema !== undefined) {
        recordOf(tool.input_schema, `tools[${index}].input_schema`);
        boundedJsonValue(tool.input_schema, `tools[${index}].input_schema`);
      }
    }
  }
  if (record.resources !== undefined) {
    if (!Array.isArray(record.resources) || record.resources.length > MAX_COLLECTION_ENTRIES) {
      throw new Error(`resources must be an array of at most ${MAX_COLLECTION_ENTRIES} entries`);
    }
    for (const [index, value] of record.resources.entries()) {
      const resource = closedObject(value, `resources[${index}]`, [
        'uri',
        'name',
        'description',
        'mimeType',
      ]);
      boundedRequiredString(resource, 'uri', `resources[${index}]`);
      boundedRequiredString(resource, 'name', `resources[${index}]`);
      boundedOptionalString(resource, 'description', `resources[${index}]`);
      if (resource.mimeType !== undefined) {
        boundedRequiredString(resource, 'mimeType', `resources[${index}]`);
      }
    }
  }
  if (record.prompts !== undefined) {
    if (!Array.isArray(record.prompts) || record.prompts.length > MAX_COLLECTION_ENTRIES) {
      throw new Error(`prompts must be an array of at most ${MAX_COLLECTION_ENTRIES} entries`);
    }
    for (const [index, value] of record.prompts.entries()) {
      const prompt = closedObject(value, `prompts[${index}]`, ['name', 'description', 'arguments']);
      boundedRequiredString(prompt, 'name', `prompts[${index}]`);
      boundedOptionalString(prompt, 'description', `prompts[${index}]`);
      if (prompt.arguments === undefined) continue;
      if (!Array.isArray(prompt.arguments) || prompt.arguments.length > MAX_COLLECTION_ENTRIES) {
        throw new Error(
          `prompts[${index}].arguments must be an array of at most ${MAX_COLLECTION_ENTRIES} entries`
        );
      }
      for (const [argumentIndex, value] of prompt.arguments.entries()) {
        const argument = closedObject(value, `prompts[${index}].arguments[${argumentIndex}]`, [
          'name',
          'description',
          'required',
        ]);
        boundedRequiredString(argument, 'name', `prompts[${index}].arguments[${argumentIndex}]`);
        boundedOptionalString(
          argument,
          'description',
          `prompts[${index}].arguments[${argumentIndex}]`
        );
        if (argument.required !== undefined && typeof argument.required !== 'boolean') {
          throw new Error(`prompts[${index}].arguments[${argumentIndex}].required must be boolean`);
        }
      }
    }
  }
}

function assertTransportCombination(record: Record<string, unknown>, complete: boolean): void {
  const transport = record.transport;
  if (transport === undefined && !complete) return;
  if (!MCP_TRANSPORTS.includes(transport as (typeof MCP_TRANSPORTS)[number])) {
    throw new Error(`transport must be one of ${MCP_TRANSPORTS.join(', ')}`);
  }
  if (transport === 'stdio') {
    if (complete && (typeof record.command !== 'string' || !record.command.trim())) {
      throw new Error('command is required for stdio transport');
    }
    for (const field of ['url', 'headers', 'auth'] as const) {
      if (record[field] !== undefined && record[field] !== null) {
        throw new Error(`${field} does not apply to stdio transport`);
      }
    }
    return;
  }
  if (complete && (typeof record.url !== 'string' || !record.url.trim())) {
    throw new Error(`url is required for ${String(transport)} transport`);
  }
  for (const field of ['command', 'args'] as const) {
    if (record[field] !== undefined) throw new Error(`${field} only applies to stdio transport`);
  }
}

function assertProvenance(record: Record<string, unknown>, complete: boolean): void {
  if (!complete && record.source === undefined) return;
  const source = record.source ?? 'user';
  if (!['user', 'imported', 'agor', 'catalog'].includes(String(source))) {
    throw new Error('source must be user, imported, agor, or catalog');
  }
  if (source === 'imported') {
    if (complete && (typeof record.import_path !== 'string' || !record.import_path.trim())) {
      throw new Error('import_path is required for imported MCP servers');
    }
    if (record.catalog_entry_name !== undefined) {
      throw new Error('catalog_entry_name only applies to catalog MCP servers');
    }
    return;
  }
  if (source === 'catalog') {
    if (
      complete &&
      (typeof record.catalog_entry_name !== 'string' || !record.catalog_entry_name.trim())
    ) {
      throw new Error('catalog_entry_name is required for catalog MCP servers');
    }
    if (record.import_path !== undefined) {
      throw new Error('import_path only applies to imported MCP servers');
    }
    return;
  }
  if (record.import_path !== undefined || record.catalog_entry_name !== undefined) {
    throw new Error('import/catalog provenance fields do not apply to this MCP server source');
  }
}

function assertLegacyCompatibleProvenance(record: Record<string, unknown>): void {
  const source = record.source ?? 'user';
  if (!['user', 'imported', 'agor', 'catalog'].includes(String(source))) {
    throw new Error('source must be user, imported, agor, or catalog');
  }
  // Historical imports may be missing their optional path, and historical
  // catalog rows may be missing the redundant catalog stamp. They still may
  // not carry evidence belonging to another provenance family.
  if (source === 'imported') {
    if (record.catalog_entry_name !== undefined) {
      throw new Error('catalog_entry_name only applies to catalog MCP servers');
    }
    return;
  }
  if (source === 'catalog') {
    if (record.import_path !== undefined) {
      throw new Error('import_path only applies to imported MCP servers');
    }
    return;
  }
  if (record.import_path !== undefined || record.catalog_entry_name !== undefined) {
    throw new Error('import/catalog provenance fields do not apply to this MCP server source');
  }
}

/**
 * Closed runtime schema shared by the public Feathers boundary and the final
 * repository persistence check. Public callers get the narrow field set;
 * trusted catalog/import/discovery calls opt into the separate internal set.
 */
function validateMCPServerWrite(value: unknown, options: MCPServerWriteValidationOptions): void {
  const record = recordOf(value, 'MCP server input');
  const complete = options.operation === 'create';
  const allowed = complete
    ? options.trusted
      ? TRUSTED_CREATE_FIELDS
      : PUBLIC_CREATE_FIELDS
    : options.trusted
      ? TRUSTED_MUTATION_FIELDS
      : PUBLIC_MUTATION_FIELDS;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Unknown MCP server field: ${key}`);
  }

  optionalString(record, 'name', { required: complete, max: MAX_NAME_LENGTH });
  optionalString(record, 'display_name', { max: MAX_NAME_LENGTH });
  optionalString(record, 'description');
  optionalString(record, 'command');
  optionalString(record, 'url', { url: true });
  optionalString(record, 'import_path');
  optionalString(record, 'catalog_entry_name', { max: MAX_NAME_LENGTH });
  stringArray(record, 'args');
  stringMap(record, 'headers', { allowSentinel: !complete });
  stringMap(record, 'env', { allowSentinel: !complete });
  toolPermissions(record);
  capabilities(record);

  if (record.scope === undefined && complete) throw new Error('scope is required');
  if (record.scope !== undefined && !MCP_SCOPES.includes(record.scope as never)) {
    throw new Error(`scope must be one of ${MCP_SCOPES.join(', ')}`);
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new Error('enabled must be boolean');
  }
  if (record.replace_auth !== undefined && typeof record.replace_auth !== 'boolean') {
    throw new Error('replace_auth must be boolean');
  }
  if (
    record.replace_auth === true &&
    (!Object.hasOwn(record, 'auth') || record.auth === undefined)
  ) {
    throw new Error('replace_auth requires auth to be provided');
  }
  if (record.owner_user_id !== undefined && record.owner_user_id !== null) {
    if (!isCanonicalFullUuid(record.owner_user_id)) {
      throw new Error('owner_user_id must be a canonical full UUID or null');
    }
  }
  if (record.expected_config_version !== undefined) {
    if (
      !Number.isSafeInteger(record.expected_config_version) ||
      Number(record.expected_config_version) < 1
    ) {
      throw new Error('expected_config_version must be a positive safe integer');
    }
  }
  if ('auth' in record && record.auth !== undefined) {
    assertValidMCPAuthPatch(record.auth, {
      create: complete,
      requireConfiguredCredentials: options.requireConfiguredCredentials,
    });
  }

  if (options.enforceTransportCombination !== false) {
    assertTransportCombination(record, complete);
  }
  if (options.trusted) {
    if (options.allowLegacyProvenance) {
      assertLegacyCompatibleProvenance(record);
    } else {
      assertProvenance(record, complete);
    }
  }
}

export function assertValidMCPServerWrite(
  value: unknown,
  options: MCPServerWriteValidationOptions
): void {
  try {
    validateMCPServerWrite(value, options);
  } catch (error) {
    if (error instanceof MCPServerWriteValidationError) throw error;
    throw new MCPServerWriteValidationError(
      error instanceof Error ? error.message : 'Invalid MCP server input'
    );
  }
}

/** Validate the fully merged row immediately before repository persistence. */
export function assertValidEffectiveMCPServer(
  server: Partial<MCPServer>,
  options: { allowLegacyProvenance?: boolean } = {}
): void {
  const persisted = {
    name: server.name,
    display_name: server.display_name,
    description: server.description,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    headers: server.headers,
    env: server.env,
    auth: server.auth,
    scope: server.scope,
    owner_user_id: server.owner_user_id,
    source: server.source,
    import_path: server.import_path,
    catalog_entry_name: server.catalog_entry_name,
    enabled: server.enabled,
    tools: server.tools,
    resources: server.resources,
    prompts: server.prompts,
    tool_permissions: server.tool_permissions,
  };
  assertValidMCPServerWrite(persisted, {
    operation: 'create',
    trusted: true,
    enforceTransportCombination: true,
    allowLegacyProvenance: options.allowLegacyProvenance,
  });
}

/** Fail closed on provider-controlled discovery output before it reaches JSON persistence. */
export function assertValidDiscoveredMCPCapabilities(value: unknown): void {
  try {
    const record = recordOf(value, 'discovered MCP capabilities');
    for (const key of Object.keys(record)) {
      if (!['tools', 'resources', 'prompts'].includes(key)) {
        throw new Error(`Unknown discovered MCP capabilities field: ${key}`);
      }
    }
    capabilities(record);
  } catch (error) {
    if (error instanceof MCPServerWriteValidationError) throw error;
    throw new MCPServerWriteValidationError(
      error instanceof Error ? error.message : 'Invalid discovered MCP capabilities'
    );
  }
}

const ARCHIVED_MCP_SERVER_ROW_FIELDS = new Set([
  'tenant_id',
  'mcp_server_id',
  'created_at',
  'updated_at',
  'name',
  'transport',
  'scope',
  'enabled',
  'owner_user_id',
  'source',
  'catalog_entry_name',
  'data',
]);

const ARCHIVED_MCP_SERVER_DATA_FIELDS = new Set([
  'display_name',
  'description',
  'import_path',
  'catalog_entry_name',
  'config_version',
  'command',
  'args',
  'url',
  'headers',
  'env',
  'auth',
  'tools',
  'resources',
  'prompts',
  'tool_permissions',
]);

/**
 * Compatibility contract for rows emitted by the 962f74fe-era archive.
 * Historical bearer/JWT rows may be intentionally incomplete and MCP
 * capability descriptions/schemas were optional on the wire. Everything is
 * still closed, sentinel-free, transport-valid, and provenance-checked.
 */
function assertValidArchiveCompatibleMCPServer(server: Partial<MCPServer>): void {
  assertValidEffectiveMCPServer(server, { allowLegacyProvenance: true });
}

/** Closed validation for the physical `mcp_servers` archive row before import. */
export function assertValidArchivedMCPServerRow(value: unknown): void {
  try {
    const row = recordOf(value, 'archived mcp_servers row');
    for (const key of Object.keys(row)) {
      if (!ARCHIVED_MCP_SERVER_ROW_FIELDS.has(key)) {
        throw new Error(`Unknown archived mcp_servers field: ${key}`);
      }
    }
    if (typeof row.mcp_server_id !== 'string' || !isValidUUID(row.mcp_server_id)) {
      throw new Error('archived mcp_server_id must be a UUID');
    }
    if (typeof row.tenant_id !== 'string' || !row.tenant_id.trim()) {
      throw new Error('archived tenant_id must be a non-empty string');
    }
    if (typeof row.enabled !== 'boolean') {
      throw new Error('archived enabled must be boolean');
    }
    if (!['user', 'imported', 'agor', 'catalog'].includes(String(row.source))) {
      throw new Error('archived source must be user, imported, agor, or catalog');
    }
    for (const field of ['created_at', 'updated_at'] as const) {
      const timestamp = row[field];
      // Older legal archives omitted updated_at; created_at has always been
      // required and remains the fallback used by destination persistence.
      if (
        (field === 'updated_at' && (timestamp === undefined || timestamp === null)) ||
        (typeof timestamp === 'string' && timestamp.trim() && !Number.isNaN(Date.parse(timestamp)))
      ) {
        continue;
      }
      throw new Error(`archived ${field} must be an ISO-compatible timestamp`);
    }
    const data = recordOf(row.data, 'archived mcp_servers.data');
    for (const key of Object.keys(data)) {
      if (!ARCHIVED_MCP_SERVER_DATA_FIELDS.has(key)) {
        throw new Error(`Unknown archived mcp_servers.data field: ${key}`);
      }
    }
    const revision = data.config_version;
    if (
      revision !== undefined &&
      (!Number.isSafeInteger(revision) ||
        Number(revision) < 1 ||
        Number(revision) >= Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error('archived MCP config_version must be a non-exhausted positive safe integer');
    }
    if (
      row.catalog_entry_name !== undefined &&
      row.catalog_entry_name !== null &&
      data.catalog_entry_name !== undefined &&
      row.catalog_entry_name !== data.catalog_entry_name
    ) {
      throw new Error('archived MCP catalog_entry_name columns disagree');
    }
    const catalogEntryName = row.catalog_entry_name ?? data.catalog_entry_name;
    if (row.source === 'catalog' && (typeof catalogEntryName !== 'string' || !catalogEntryName)) {
      throw new Error('archived catalog MCP server requires catalog_entry_name evidence');
    }
    assertValidArchiveCompatibleMCPServer({
      mcp_server_id: row.mcp_server_id as MCPServer['mcp_server_id'],
      name: row.name as MCPServer['name'],
      transport: row.transport as MCPServer['transport'],
      scope: row.scope as MCPServer['scope'],
      enabled: row.enabled as MCPServer['enabled'],
      owner_user_id: (row.owner_user_id ?? undefined) as MCPServer['owner_user_id'],
      source: row.source as MCPServer['source'],
      catalog_entry_name: catalogEntryName as MCPServer['catalog_entry_name'],
      ...data,
    });
  } catch (error) {
    if (error instanceof MCPServerWriteValidationError) throw error;
    throw new MCPServerWriteValidationError(
      error instanceof Error ? error.message : 'Invalid archived MCP server row'
    );
  }
}
