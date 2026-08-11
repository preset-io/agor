import { type AgorConfig, resolveMultiTenancyConfig } from '@agor/core/config';

export function shouldRegisterLocalHostOperations(config: AgorConfig): boolean {
  return resolveMultiTenancyConfig(config).mode === 'static';
}
