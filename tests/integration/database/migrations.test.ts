import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type Migration, migrations } from '../../../migrations';
import {
  databaseHealth,
  migrateDatabase,
  migrationChecksum,
  openDatabase
} from '../../../src/lib/server/platform/database';
import { DATABASE_SCHEMA_VERSION } from '../../../src/lib/server/platform/version';
import preCollapseSchema from '../../fixtures/database/pre-collapse-schema-signature.json';
import { databaseSchemaSignature } from '../../helpers/database-schema-signature';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function databasePath(): Promise<string> {
  const temporary = await createTemporaryDirectory('poyo-db-');
  cleanups.push(temporary.cleanup);
  return join(temporary.path, 'studio.sqlite');
}

const expectedTables = [
  'app_settings',
  'attachment_requests',
  'balance_snapshots',
  'cleanup_actions',
  'cleanup_attempts',
  'cleanup_policies',
  'cleanup_previews',
  'download_attempts',
  'job_events',
  'job_inputs',
  'job_outputs',
  'job_tags',
  'jobs',
  'managed_sources',
  'model_preferences',
  'presets',
  'registry_audits',
  'registry_entries',
  'registry_versions',
  'schema_migrations',
  'secret_metadata',
  'submission_intents',
  'tags',
  'work_claims'
];

describe('database migrations', () => {
  test('DB-00 preserves the immutable version-1 schema provenance', async () => {
    const initialMigration = migrations[0];
    if (!initialMigration) throw new Error('Expected the registered initial migration.');

    const database = await openDatabase(await databasePath(), { migrations: [initialMigration] });
    try {
      expect(databaseSchemaSignature(database)).toEqual(preCollapseSchema.schema);
    } finally {
      database.close();
    }
  });

  test('registers the exact version-1 through version-3 migration chain', () => {
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3]);
    expect(migrations.at(-1)?.version).toBe(DATABASE_SCHEMA_VERSION);
  });

  test('DB-01 creates the complete schema with SQLite safety pragmas', async () => {
    const database = await openDatabase(await databasePath());
    try {
      const tables = database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`
        )
        .all()
        .map((row) => row.name);
      const indexes = database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name`
        )
        .all();
      const applied = database
        .query<{ version: number; name: string; checksum: string }, []>(
          'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
        )
        .all();
      const galleryOrderColumns = database
        .query<{ name: string; desc: number; key: number }, []>(
          "PRAGMA index_xinfo('idx_jobs_gallery_order')"
        )
        .all()
        .filter((column) => column.key === 1)
        .map((column) => ({ name: column.name, desc: column.desc }));
      const journal = database.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
      const health = databaseHealth(database);
      const inputColumns = database
        .query<{ name: string }, []>('PRAGMA table_info(job_inputs)')
        .all()
        .map((column) => column.name);
      const outputColumns = database
        .query<{ name: string }, []>('PRAGMA table_info(job_outputs)')
        .all()
        .map((column) => column.name);
      const sourceForeignKey = database
        .query<{ table: string; from: string; to: string }, []>(
          'PRAGMA foreign_key_list(job_inputs)'
        )
        .all()
        .find((foreignKey) => foreignKey.from === 'managed_source_id');
      const attachmentForeignKey = database
        .query<{ table: string; from: string; to: string; on_delete: string }, []>(
          'PRAGMA foreign_key_list(attachment_requests)'
        )
        .all()
        .find((foreignKey) => foreignKey.from === 'job_output_id');
      const attachmentIndexes = database
        .query<{ name: string; unique: number }, []>('PRAGMA index_list(attachment_requests)')
        .all();
      database
        .query(
          `INSERT INTO jobs(id,workflow,public_model_id,local_phase,guided_request_json,correlation_id,created_at,updated_at)
           VALUES ('migration-job','text-to-image','model','complete','{}','migration-correlation','2026-07-31T00:00:00.000Z','2026-07-31T00:00:00.000Z')`
        )
        .run();
      database
        .query(
          `INSERT INTO job_outputs(id,job_id,output_order,media_kind,download_state,created_at)
           VALUES ('migration-output','migration-job',0,'image','verified','2026-07-31T00:00:00.000Z')`
        )
        .run();
      database
        .query(
          `INSERT INTO attachment_requests(id,request_token,job_output_id,requested_at)
           VALUES ('migration-request','migration-token','migration-output','2026-07-31T00:00:00.000Z')`
        )
        .run();
      expect(() =>
        database
          .query(
            `INSERT INTO attachment_requests(id,request_token,job_output_id,requested_at)
             VALUES ('migration-request-2','migration-token','migration-output','2026-07-31T00:01:00.000Z')`
          )
          .run()
      ).toThrow();
      database.query("DELETE FROM job_outputs WHERE id='migration-output'").run();
      const attachmentCount = database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM attachment_requests')
        .get()?.count;

      expect(tables).toEqual(expectedTables);
      expect(indexes.length).toBeGreaterThanOrEqual(18);
      expect(applied).toEqual(
        migrations.map((migration) => ({
          version: migration.version,
          name: migration.name,
          checksum: migrationChecksum(migration)
        }))
      );
      expect(galleryOrderColumns).toEqual([
        { name: 'created_at', desc: 1 },
        { name: 'id', desc: 1 }
      ]);
      expect(inputColumns).toContain('managed_source_id');
      expect(outputColumns).toEqual(expect.arrayContaining(['pixel_width', 'pixel_height']));
      expect(sourceForeignKey).toMatchObject({ table: 'managed_sources', to: 'id' });
      expect(attachmentForeignKey).toMatchObject({
        table: 'job_outputs',
        to: 'id',
        on_delete: 'CASCADE'
      });
      expect(attachmentIndexes.some((index) => index.unique === 1)).toBe(true);
      expect(
        attachmentIndexes.some((index) => index.name === 'idx_attachment_requests_ledger')
      ).toBe(true);
      expect(attachmentCount).toBe(0);
      expect(journal?.journal_mode).toBe('wal');
      expect(health).toEqual({
        quickCheck: 'ok',
        foreignKeys: true,
        schemaVersion: DATABASE_SCHEMA_VERSION
      });
    } finally {
      database.close();
    }
  });

  test('DB-02 upgrades a canonical version-1 database, preserves sentinels, and reopens idempotently', async () => {
    const path = await databasePath();
    const initialMigration = migrations[0];
    if (!initialMigration) throw new Error('Expected the registered initial migration.');

    const versionOne = await openDatabase(path, { migrations: [initialMigration] });
    versionOne
      .query(
        `INSERT INTO app_settings(key, value_version, value_json, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run('theme', 1, '{"mode":"dark"}', '2026-07-28T00:00:00.000Z');
    versionOne
      .query(
        `INSERT INTO jobs(
           id, workflow, public_model_id, local_phase, guided_request_json, correlation_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'sentinel-job',
        'image',
        'model',
        'complete',
        '{}',
        'sentinel-correlation',
        '2026-07-28T00:00:00.000Z',
        '2026-07-28T00:00:00.000Z'
      );
    versionOne
      .query(
        `INSERT INTO job_outputs(id, job_id, output_order, media_kind, local_path, download_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'sentinel-output',
        'sentinel-job',
        0,
        'image',
        'outputs/sentinel.png',
        'verified',
        '2026-07-28T00:00:00.000Z'
      );
    versionOne.close();

    const upgraded = await openDatabase(path);
    try {
      expect(
        upgraded
          .query<{ value_json: string }, []>(
            "SELECT value_json FROM app_settings WHERE key = 'theme'"
          )
          .get()?.value_json
      ).toBe('{"mode":"dark"}');
      expect(
        upgraded
          .query<{ id: string }, []>("SELECT id FROM job_outputs WHERE id = 'sentinel-output'")
          .get()?.id
      ).toBe('sentinel-output');
      expect(
        upgraded
          .query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version')
          .all()
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      expect(databaseHealth(upgraded).schemaVersion).toBe(3);
      expect(
        upgraded
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_gallery_order'"
          )
          .get()?.count
      ).toBe(1);
    } finally {
      upgraded.close();
    }

    const reopened = await openDatabase(path);
    try {
      expect(
        reopened
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schema_migrations')
          .get()?.count
      ).toBe(3);
      expect(
        reopened
          .query<{ id: string }, []>("SELECT id FROM job_outputs WHERE id = 'sentinel-output'")
          .get()?.id
      ).toBe('sentinel-output');
    } finally {
      reopened.close();
    }
  });

  test('DB-03 applies the initial schema to a zero-version fixture', async () => {
    const path = await databasePath();
    const fixture = new Database(path, { create: true, strict: true });
    fixture.exec('CREATE TABLE fixture_data(value TEXT NOT NULL);');
    fixture.query('INSERT INTO fixture_data(value) VALUES (?)').run('retained');
    fixture.close();

    const upgraded = await openDatabase(path);
    try {
      expect(
        upgraded.query<{ value: string }, []>('SELECT value FROM fixture_data').get()?.value
      ).toBe('retained');
      expect(databaseHealth(upgraded).schemaVersion).toBe(DATABASE_SCHEMA_VERSION);
    } finally {
      upgraded.close();
    }
  });

  test('DB-04 rolls back a broken version-2 migration while retaining canonical version-1 data', async () => {
    const path = await databasePath();
    const initialMigration = migrations[0];
    if (!initialMigration) throw new Error('Expected the registered initial migration.');

    const database = new Database(path, { create: true, strict: true });
    database.exec('PRAGMA foreign_keys = ON;');
    migrateDatabase(database, [initialMigration]);
    database
      .query(
        `INSERT INTO app_settings(key, value_version, value_json, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run('sentinel', 1, '{}', '2026-07-28T00:00:00.000Z');
    const broken: Migration = {
      version: 2,
      name: 'broken version-2 migration',
      sql: 'CREATE TABLE half_applied(id INTEGER PRIMARY KEY); INVALID SQL;'
    };

    expect(() => migrateDatabase(database, [initialMigration, broken])).toThrow();
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'half_applied'"
        )
        .get()?.count
    ).toBe(0);
    expect(
      database
        .query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version')
        .all()
    ).toEqual([{ version: 1 }]);
    expect(
      database
        .query<{ value_json: string }, []>(
          "SELECT value_json FROM app_settings WHERE key = 'sentinel'"
        )
        .get()?.value_json
    ).toBe('{}');
    database.close();
  });

  test('rejects changed migration contents after checksum recording', async () => {
    const path = await databasePath();
    const migration: Migration = {
      version: 1,
      name: 'fixture',
      sql: 'CREATE TABLE fixture(id INTEGER PRIMARY KEY);'
    };
    const database = new Database(path, { create: true, strict: true });
    migrateDatabase(database, [migration]);
    expect(migrationChecksum(migration)).toHaveLength(64);

    expect(() =>
      migrateDatabase(database, [{ ...migration, sql: `${migration.sql} SELECT 1;` }])
    ).toThrow('checksum');
    database.close();
  });
});
