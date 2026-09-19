import type { Database } from 'bun:sqlite';
import type { HealthDto } from '../../features/diagnostics/contracts';
import { databaseHealth } from '../platform/database';
import { APP_VERSION, DATABASE_SCHEMA_VERSION, REGISTRY_SCHEMA_VERSION } from '../platform/version';
import type { ApiKeyStatusDto } from '../settings/api-key-manager';
import type { StructuredLogger } from './jsonl-logger';

export interface HealthDependencies {
  database: Database;
  apiKey: ApiKeyStatusDto;
  logger: StructuredLogger;
  now?: () => Date;
}

export async function buildHealthDto(dependencies: HealthDependencies): Promise<HealthDto> {
  const database = databaseHealth(dependencies.database);
  const logging = await dependencies.logger.diagnostics();
  const status =
    database.quickCheck === 'ok' &&
    database.foreignKeys &&
    database.schemaVersion === DATABASE_SCHEMA_VERSION &&
    logging.status === 'ok'
      ? 'ok'
      : 'degraded';

  return {
    status,
    checkedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    application: {
      version: APP_VERSION,
      databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      registrySchemaVersion: REGISTRY_SCHEMA_VERSION
    },
    network: {
      defaultHost: '127.0.0.1',
      loopbackOnlyByDefault: true
    },
    database: {
      status: database.quickCheck,
      foreignKeys: database.foreignKeys,
      schemaVersion: database.schemaVersion
    },
    apiKey: {
      source: dependencies.apiKey.source,
      status: dependencies.apiKey.status,
      storeKind: dependencies.apiKey.storeKind,
      onboardingAvailable: dependencies.apiKey.onboardingAvailable,
      environmentManaged: dependencies.apiKey.environmentManaged
    },
    logging
  };
}
