import { and, eq } from 'drizzle-orm';
import type {
  AgenticToolConfigField,
  ProviderConnection,
  ProviderConnectionTool,
  ProviderResolutionPolicy,
  StoredTenantAgenticToolSettings,
  TenantAgenticToolName,
  TenantAgenticToolSettingsPatch,
  UserID,
} from '../../types';
import {
  DEFAULT_PROVIDER_RESOLUTION_POLICY,
  isProviderConnectionTool,
  PROVIDER_RESOLUTION_POLICIES,
  TENANT_PROVIDER_CONNECTION_FIELDS,
} from '../../types';
import type { Database } from '../client';
import {
  isPostgresDatabase,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
} from '../database-wrapper';
import { appVariables } from '../schema';
import { getCurrentTenantDatabase } from '../tenant-scope';
import { AppVariableRepository } from './app-variables';

export const TENANT_AGENTIC_TOOLS_NAMESPACE = 'agentic_tools';

function allowedFields(tool: TenantAgenticToolName): readonly AgenticToolConfigField[] {
  return isProviderConnectionTool(tool) ? TENANT_PROVIDER_CONNECTION_FIELDS[tool] : [];
}

function parseSettings(
  tool: TenantAgenticToolName,
  value: string
): StoredTenantAgenticToolSettings {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid stored tenant agentic-tool settings for ${tool}`);
  }
  const input = parsed as {
    enabled?: unknown;
    resolution_policy?: unknown;
    inline_configuration_allowed?: unknown;
    connection?: unknown;
  };
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error(`Invalid enabled value in tenant agentic-tool settings for ${tool}`);
  }
  if (
    input.resolution_policy !== undefined &&
    !(PROVIDER_RESOLUTION_POLICIES as readonly unknown[]).includes(input.resolution_policy)
  ) {
    throw new Error(`Invalid resolution policy in tenant agentic-tool settings for ${tool}`);
  }
  if (
    input.inline_configuration_allowed !== undefined &&
    typeof input.inline_configuration_allowed !== 'boolean'
  ) {
    throw new Error(`Invalid inline configuration policy for ${tool}`);
  }
  if (
    input.connection !== undefined &&
    (!input.connection || typeof input.connection !== 'object' || Array.isArray(input.connection))
  ) {
    throw new Error(`Invalid connection in tenant agentic-tool settings for ${tool}`);
  }

  const allowed = new Set(allowedFields(tool));
  const connection: Record<string, string> = {};
  for (const [field, raw] of Object.entries(input.connection ?? {})) {
    if (!allowed.has(field as AgenticToolConfigField) || typeof raw !== 'string') {
      throw new Error(`Invalid connection field ${field} for ${tool}`);
    }
    const value = raw.trim();
    if (value) connection[field] = value;
  }
  const resolutionPolicy = input.resolution_policy as ProviderResolutionPolicy | undefined;
  return {
    ...(input.enabled === false ? { enabled: false } : {}),
    ...(resolutionPolicy && resolutionPolicy !== DEFAULT_PROVIDER_RESOLUTION_POLICY
      ? { resolution_policy: resolutionPolicy }
      : {}),
    ...(input.inline_configuration_allowed === false
      ? { inline_configuration_allowed: false }
      : {}),
    ...(Object.keys(connection).length > 0 ? { connection } : {}),
  };
}

/** Typed, encrypted tenant settings. Tenant identity comes from the ambient DB scope. */
export class TenantAgenticToolSettingsRepository {
  private variables: AppVariableRepository;

  constructor(private db: Database) {
    this.variables = new AppVariableRepository(db);
  }

  async find(tool: TenantAgenticToolName): Promise<StoredTenantAgenticToolSettings> {
    const plaintext = await this.variables.getPlain(TENANT_AGENTIC_TOOLS_NAMESPACE, tool);
    return plaintext ? parseSettings(tool, plaintext) : {};
  }

  async isEnabled(tool: TenantAgenticToolName): Promise<boolean> {
    return (await this.find(tool)).enabled !== false;
  }

  async resolutionPolicy(tool: TenantAgenticToolName) {
    return (await this.find(tool)).resolution_policy ?? DEFAULT_PROVIDER_RESOLUTION_POLICY;
  }

  async connection<T extends ProviderConnectionTool>(
    tool: T
  ): Promise<ProviderConnection<T> | null> {
    const settings = await this.find(tool);
    return settings.connection ? (settings.connection as ProviderConnection<T>) : null;
  }

  async patch(
    tool: TenantAgenticToolName,
    patch: TenantAgenticToolSettingsPatch,
    updatedBy?: UserID | null
  ): Promise<StoredTenantAgenticToolSettings> {
    const allowed = new Set(allowedFields(tool));
    for (const field of Object.keys(patch.connection ?? {}) as AgenticToolConfigField[]) {
      if (!allowed.has(field)) throw new Error(`Unsupported connection field ${field} for ${tool}`);
    }

    const apply = async (txDb: Database) => {
      const variables = new AppVariableRepository(txDb);
      await variables.setIfAbsent({
        namespace: TENANT_AGENTIC_TOOLS_NAMESPACE,
        key: tool,
        value: '{}',
        encrypted: true,
        content_type: 'application/json',
        updated_by: updatedBy ?? null,
      });
      await lockRowForUpdate(
        txDb,
        this.db,
        appVariables,
        and(eq(appVariables.namespace, TENANT_AGENTIC_TOOLS_NAMESPACE), eq(appVariables.key, tool))!
      );

      const currentPlain = await variables.getPlain(TENANT_AGENTIC_TOOLS_NAMESPACE, tool);
      const current = currentPlain ? parseSettings(tool, currentPlain) : {};
      const connection = { ...(current.connection ?? {}) };
      for (const [field, raw] of Object.entries(patch.connection ?? {})) {
        const value = raw?.trim();
        if (value) connection[field] = value;
        else delete connection[field];
      }
      const resolutionPolicy =
        patch.resolution_policy ?? current.resolution_policy ?? DEFAULT_PROVIDER_RESOLUTION_POLICY;
      const next: StoredTenantAgenticToolSettings = {
        ...((patch.enabled ?? current.enabled) === false ? { enabled: false } : {}),
        ...(resolutionPolicy !== DEFAULT_PROVIDER_RESOLUTION_POLICY
          ? { resolution_policy: resolutionPolicy }
          : {}),
        ...((patch.inline_configuration_allowed ?? current.inline_configuration_allowed) === false
          ? { inline_configuration_allowed: false }
          : {}),
        ...(Object.keys(connection).length > 0 ? { connection } : {}),
      };

      if (Object.keys(next).length === 0) {
        await variables.delete(TENANT_AGENTIC_TOOLS_NAMESPACE, tool);
      } else {
        await variables.set({
          namespace: TENANT_AGENTIC_TOOLS_NAMESPACE,
          key: tool,
          value: JSON.stringify(next),
          encrypted: true,
          content_type: 'application/json',
          updated_by: updatedBy ?? null,
        });
      }
      return next;
    };

    const ambientDb = getCurrentTenantDatabase();
    if (ambientDb && isPostgresDatabase(ambientDb)) return apply(ambientDb);
    if (isSQLiteDatabase(this.db)) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await runDatabaseTransaction(this.db, apply, { sqliteImmediate: true });
        } catch (error) {
          if ((error as { code?: string }).code !== 'SQLITE_BUSY' || attempt >= 9) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
        }
      }
    }
    return runDatabaseTransaction(this.db, apply);
  }
}
