import {
  type MaterializeAgenticToolConfigurationArgs,
  materializeAgenticToolConfiguration as materializeHostConfiguration,
} from '@agor/core/config';
import type { Database } from '@agor/core/db';
import { getAgenticToolIntegration } from './index.js';

export async function materializeAgenticToolConfiguration(
  db: Database,
  args: MaterializeAgenticToolConfigurationArgs
) {
  return materializeHostConfiguration(db, {
    ...args,
    modelConfiguration: getAgenticToolIntegration(args.tool).configuration,
  });
}
