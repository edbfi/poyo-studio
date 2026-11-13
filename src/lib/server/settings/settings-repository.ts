import { normalizeGenerationRetries } from '../../features/generation/retries';
import { JobRepository } from '../jobs/repository';
import { DatabaseRepository } from '../platform/repository';

interface SettingRow {
  key: string;
  value_version: number;
  value_json: string;
  updated_at: string;
}

export interface StoredSetting<T = unknown> {
  key: string;
  version: number;
  value: T;
  updatedAt: string;
}

const forbiddenSettingKey = /(api.?key|authorization|bearer|credential|password|secret|token)/i;
const secretString = /(?:\bsk[-_][a-z0-9_-]{8,}|\bbearer\s+\S+)/i;

function assertSafeSettingValue(value: unknown, path = 'value'): void {
  if (typeof value === 'string' && secretString.test(value)) {
    throw new Error(`Setting ${path} appears to contain secret material.`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertSafeSettingValue(entry, `${path}[${index}]`);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenSettingKey.test(key)) {
      throw new Error(`Setting ${path}.${key} is reserved for secret metadata.`);
    }
    assertSafeSettingValue(nested, `${path}.${key}`);
  }
}

export class SettingsRepository extends DatabaseRepository {
  get<T>(key: string): StoredSetting<T> | null {
    const row = this.database
      .query<SettingRow, [string]>(
        'SELECT key, value_version, value_json, updated_at FROM app_settings WHERE key = ?'
      )
      .get(key);
    if (!row) return null;

    const parsed: unknown = JSON.parse(row.value_json);
    const operations =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    return {
      key: row.key,
      version: row.value_version,
      value: (key === 'operations' && operations
        ? {
            ...operations,
            generationRetries: normalizeGenerationRetries(operations.generationRetries)
          }
        : parsed) as T,
      updatedAt: row.updated_at
    };
  }

  set<T>(key: string, value: T, version = 1, now = new Date()): StoredSetting<T> {
    if (!key || forbiddenSettingKey.test(key)) {
      throw new Error('Secret-like keys cannot be stored in application settings.');
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error('Setting versions must be positive integers.');
    }
    assertSafeSettingValue(value);
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined) throw new Error('Setting value is not JSON serializable.');
    const updatedAt = now.toISOString();

    return this.transaction(() => {
      this.database
        .query(
          `INSERT INTO app_settings(key, value_version, value_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_version = excluded.value_version,
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
        )
        .run(key, version, valueJson, updatedAt);

      if (
        key === 'operations' &&
        !normalizeGenerationRetries((value as { generationRetries?: unknown })?.generationRetries)
          .enabled
      )
        new JobRepository(this.database).stopAllAutomaticRetries();
      return { key, version, value, updatedAt };
    });
  }

  delete(key: string): boolean {
    return this.database.query('DELETE FROM app_settings WHERE key = ?').run(key).changes > 0;
  }
}
