import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { migrations } from '../../../migrations';
import {
  migrateDatabase,
  migrationChecksum,
  openDatabase,
  preflightDatabase
} from '../../../src/lib/server/platform/database';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];
const CRASH_WRITER = resolve('tests/fixtures/database/crash-writer.ts');

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function path(): Promise<string> {
  const temporary = await createTemporaryDirectory('poyo-db-preflight-');
  cleanups.push(temporary.cleanup);
  return join(temporary.path, 'data', 'poyo-studio.sqlite');
}

async function createSchemaHistory(
  databasePath: string,
  version: number,
  identity: 'registered' | 'fixture' = 'fixture'
): Promise<void> {
  await mkdir(join(databasePath, '..'), { recursive: true });
  const database = new Database(databasePath, { create: true, strict: true });
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const registered = migrations.find((migration) => migration.version === version);
  database
    .query('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
    .run(
      version,
      identity === 'registered' && registered ? registered.name : 'fixture',
      identity === 'registered' && registered ? migrationChecksum(registered) : 'fixture-checksum',
      '2026-07-17T00:00:00.000Z'
    );
  database.close();
}

async function createCompatibleDatabase(databasePath: string): Promise<void> {
  await mkdir(join(databasePath, '..'), { recursive: true });
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    migrateDatabase(database);
  } finally {
    database.close();
  }
}
async function createCanonicalVersionOneDatabase(databasePath: string): Promise<void> {
  await mkdir(join(databasePath, '..'), { recursive: true });
  const initialMigration = migrations[0];
  if (!initialMigration) throw new Error('Expected the registered initial migration.');

  const database = new Database(databasePath, { create: true, strict: true });
  try {
    migrateDatabase(database, [initialMigration]);
  } finally {
    database.close();
  }
}
async function createCanonicalVersionTwoDatabase(databasePath: string): Promise<void> {
  await mkdir(join(databasePath, '..'), { recursive: true });
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    migrateDatabase(database, migrations.slice(0, 2));
  } finally {
    database.close();
  }
}

async function mutateSchema(databasePath: string, sql: string): Promise<void> {
  const database = new Database(databasePath, { strict: true });
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

/** Runs the crash writer for `scenario` and kills it with SIGKILL while its connection is open. */
async function crashAfterWriting(
  databasePath: string,
  scenario: 'wal' | 'future' | 'rollback'
): Promise<void> {
  await mkdir(join(databasePath, '..'), { recursive: true });
  const writer = Bun.spawn({
    cmd: [process.execPath, CRASH_WRITER, databasePath, scenario],
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const reader = writer.stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (!output.includes('ready')) {
    const { done, value } = await reader.read();
    if (done)
      throw new Error(`crash writer ended early: ${await new Response(writer.stderr).text()}`);
    output += decoder.decode(value);
  }
  writer.kill('SIGKILL');
  await writer.exited;
}

async function sizeOf(path: string): Promise<number> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.size : 0;
}

function readOnly(databasePath: string): Database {
  return new Database(databasePath, { readonly: true, strict: true });
}

async function snapshot(databasePath: string) {
  const details = await lstat(databasePath);
  return {
    bytes: new Uint8Array(await Bun.file(databasePath).arrayBuffer()),
    size: details.size,
    mode: details.mode,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs
  };
}

async function expectRejectedWithoutMutation(databasePath: string): Promise<void> {
  const before = await snapshot(databasePath);
  const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
  const beforeSidecars = await Promise.all(
    sidecars.map(async (path) => ({
      exists: await Bun.file(path).exists(),
      bytes: (await Bun.file(path).exists())
        ? new Uint8Array(await Bun.file(path).arrayBuffer())
        : null
    }))
  );

  await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
    code: 'database_incompatible'
  });

  expect(await snapshot(databasePath)).toEqual(before);
  expect(
    await Promise.all(
      sidecars.map(async (path) => ({
        exists: await Bun.file(path).exists(),
        bytes: (await Bun.file(path).exists())
          ? new Uint8Array(await Bun.file(path).arrayBuffer())
          : null
      }))
    )
  ).toEqual(beforeSidecars);
}

describe('read-only database bootstrap preflight', () => {
  test('creates the database and active sidecars with private permissions', async () => {
    const databasePath = await path();
    await mkdir(join(databasePath, '..'), { recursive: true });
    await chmod(join(databasePath, '..'), 0o755);

    const database = await openDatabase(databasePath);
    try {
      if (typeof process.getuid === 'function') {
        for (const ownedFile of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
          if (await Bun.file(ownedFile).exists()) {
            expect((await lstat(ownedFile)).mode & 0o777).toBe(0o600);
          }
        }
      }
    } finally {
      database.close();
    }
  });

  test('does not create a missing database or its parent directory', async () => {
    const databasePath = await path();
    const parent = join(databasePath, '..');
    expect(await preflightDatabase(databasePath)).toEqual({ state: 'absent', maxVersion: null });
    expect(await Bun.file(databasePath).exists()).toBe(false);
    expect(await Bun.file(parent).exists()).toBe(false);
  });

  test('accepts a canonical version-3 database without creating sidecars', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    expect(await preflightDatabase(databasePath)).toEqual({ state: 'compatible', maxVersion: 3 });
    expect(await Bun.file(`${databasePath}-wal`).exists()).toBe(false);
    expect(await Bun.file(`${databasePath}-shm`).exists()).toBe(false);
    expect(await Bun.file(`${databasePath}-journal`).exists()).toBe(false);
  });

  test('accepts canonical version-2 upgrade input read-only without changing bytes or sidecars', async () => {
    const databasePath = await path();
    await createCanonicalVersionTwoDatabase(databasePath);
    const before = await snapshot(databasePath);
    const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];

    await expect(preflightDatabase(databasePath)).resolves.toEqual({
      state: 'compatible',
      maxVersion: 2
    });
    expect(await snapshot(databasePath)).toEqual(before);
    for (const sidecar of sidecars) expect(await Bun.file(sidecar).exists()).toBe(false);
  });

  test('accepts canonical version-1 upgrade input read-only without changing bytes or sidecars', async () => {
    const databasePath = await path();
    await createCanonicalVersionOneDatabase(databasePath);
    const before = await snapshot(databasePath);
    const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
    const beforeSidecars = await Promise.all(
      sidecars.map(async (sidecar) => ({
        exists: await Bun.file(sidecar).exists(),
        bytes: (await Bun.file(sidecar).exists())
          ? new Uint8Array(await Bun.file(sidecar).arrayBuffer())
          : null
      }))
    );

    await expect(preflightDatabase(databasePath)).resolves.toEqual({
      state: 'compatible',
      maxVersion: 1
    });

    expect(await snapshot(databasePath)).toEqual(before);
    expect(
      await Promise.all(
        sidecars.map(async (sidecar) => ({
          exists: await Bun.file(sidecar).exists(),
          bytes: (await Bun.file(sidecar).exists())
            ? new Uint8Array(await Bun.file(sidecar).arrayBuffer())
            : null
        }))
      )
    ).toEqual(beforeSidecars);
  });

  test('accepts a clean WAL-mode database without changing residual empty-WAL sidecars', async () => {
    const databasePath = await path();
    const database = await openDatabase(databasePath);
    database.close();
    const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
    const before = await snapshot(databasePath);
    const beforeSidecars = await Promise.all(
      sidecars.map(async (sidecar) => ({
        exists: await Bun.file(sidecar).exists(),
        bytes: (await Bun.file(sidecar).exists())
          ? new Uint8Array(await Bun.file(sidecar).arrayBuffer())
          : null
      }))
    );

    await expect(preflightDatabase(databasePath)).resolves.toEqual({
      state: 'compatible',
      maxVersion: 3
    });

    expect(await snapshot(databasePath)).toEqual(before);
    expect(
      await Promise.all(
        sidecars.map(async (sidecar) => ({
          exists: await Bun.file(sidecar).exists(),
          bytes: (await Bun.file(sidecar).exists())
            ? new Uint8Array(await Bun.file(sidecar).arrayBuffer())
            : null
        }))
      )
    ).toEqual(beforeSidecars);
  });

  test('rejects drifted canonical version-1 through version-3 schemas without mutation', async () => {
    for (const version of [1, 2, 3]) {
      const databasePath = await path();
      if (version === 1) await createCanonicalVersionOneDatabase(databasePath);
      else if (version === 2) await createCanonicalVersionTwoDatabase(databasePath);
      else await createCompatibleDatabase(databasePath);
      await mutateSchema(databasePath, 'DROP TABLE balance_snapshots');

      await expectRejectedWithoutMutation(databasePath);
    }
  });

  test('rejects exact migration rows with a changed index without any mutation', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    await mutateSchema(
      databasePath,
      `DROP INDEX idx_balance_snapshots_date;
       CREATE INDEX idx_balance_snapshots_date ON balance_snapshots(fetched_at ASC);`
    );
    await expectRejectedWithoutMutation(databasePath);
  });

  test('rejects exact migration rows with a changed table constraint without any mutation', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    await mutateSchema(
      databasePath,
      `ALTER TABLE model_preferences RENAME TO model_preferences_old;
       CREATE TABLE model_preferences (
         entry_key TEXT PRIMARY KEY,
         favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1, 2)),
         favorited_at TEXT,
         last_used_at TEXT
       );
       DROP TABLE model_preferences_old;
       CREATE INDEX idx_model_preferences_recent
         ON model_preferences(favorite, last_used_at DESC);`
    );
    await expectRejectedWithoutMutation(databasePath);
  });

  test('rejects exact migration rows with a changed foreign key without any mutation', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    await mutateSchema(
      databasePath,
      `PRAGMA foreign_keys = OFF;
       ALTER TABLE job_tags RENAME TO job_tags_old;
       CREATE TABLE job_tags (
         job_id TEXT NOT NULL REFERENCES jobs(id),
         tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
         PRIMARY KEY (job_id, tag_id)
       );
       DROP TABLE job_tags_old;
       CREATE INDEX idx_job_tags_tag ON job_tags(tag_id, job_id);`
    );
    await expectRejectedWithoutMutation(databasePath);
  });

  test('rejects canonical schema with foreign-key violations without any mutation', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    await mutateSchema(
      databasePath,
      `PRAGMA foreign_keys = OFF;
       INSERT INTO job_inputs(
         job_id, role, input_order, media_kind, metadata_json, availability
       ) VALUES ('missing-job', 'source', 0, 'image', '{}', 'available');`
    );
    await expectRejectedWithoutMutation(databasePath);
  });

  test('rejects wrong canonical version-1 through version-3 migration identities without mutation', async () => {
    for (const version of [1, 2, 3]) {
      const databasePath = await path();
      if (version === 1) await createCanonicalVersionOneDatabase(databasePath);
      else if (version === 2) await createCanonicalVersionTwoDatabase(databasePath);
      else await createCompatibleDatabase(databasePath);
      await mutateSchema(
        databasePath,
        `UPDATE schema_migrations SET name = 'wrong-${version}', checksum = 'wrong-${version}'
         WHERE version = ${version}`
      );

      await expectRejectedWithoutMutation(databasePath);
    }
  });

  test('rejects a gap in the applied chain without mutation', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    await mutateSchema(databasePath, 'DELETE FROM schema_migrations WHERE version = 1');

    await expectRejectedWithoutMutation(databasePath);
  });

  test('rejects former development version-2 through version-4 identities without mutation', async () => {
    for (const version of [2, 3, 4]) {
      const databasePath = await path();
      await createCanonicalVersionOneDatabase(databasePath);
      await mutateSchema(
        databasePath,
        `INSERT INTO schema_migrations(version, name, checksum, applied_at)
         VALUES (${version}, 'development migration ${version}', 'development-${version}', '2026-07-17T00:00:00.000Z')`
      );

      await expectRejectedWithoutMutation(databasePath);
    }
  });

  test('rejects a future migration version without changing DB metadata or creating WAL/SHM', async () => {
    const databasePath = await path();
    await createCanonicalVersionOneDatabase(databasePath);
    await mutateSchema(
      databasePath,
      `INSERT INTO schema_migrations(version, name, checksum, applied_at)
       VALUES (4, 'future migration', 'future-checksum', '2026-07-17T00:00:00.000Z')`
    );

    await expectRejectedWithoutMutation(databasePath);
  });

  test('recovers transactions a killed process committed only to the WAL', async () => {
    const databasePath = await path();
    await crashAfterWriting(databasePath, 'wal');
    expect(await sizeOf(`${databasePath}-wal`)).toBeGreaterThan(0);

    await expect(preflightDatabase(databasePath)).resolves.toEqual({
      state: 'compatible',
      maxVersion: 3
    });

    expect(await sizeOf(`${databasePath}-wal`)).toBe(0);
    const database = await openDatabase(databasePath);
    try {
      expect(database.query('SELECT entry_key AS entryKey FROM model_preferences').all()).toEqual([
        { entryKey: 'committed-before-crash' }
      ]);
    } finally {
      database.close();
    }
    if (typeof process.getuid === 'function') {
      expect((await lstat(databasePath)).mode & 0o777).toBe(0o600);
    }
  });

  test('rolls back a transaction a killed process left in a hot rollback journal', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    const before = new Uint8Array(await Bun.file(databasePath).arrayBuffer());
    await crashAfterWriting(databasePath, 'rollback');
    // The open transaction spilled pages into the main file before the process was killed.
    expect(await sizeOf(`${databasePath}-journal`)).toBeGreaterThan(0);
    expect(new Uint8Array(await Bun.file(databasePath).arrayBuffer())).not.toEqual(before);

    await expect(preflightDatabase(databasePath)).resolves.toEqual({
      state: 'compatible',
      maxVersion: 3
    });

    expect(await sizeOf(`${databasePath}-journal`)).toBe(0);
    expect(new Uint8Array(await Bun.file(databasePath).arrayBuffer())).toEqual(before);
  });

  test('recovers a newer schema from its WAL and then rejects it without migrating it', async () => {
    const databasePath = await path();
    await crashAfterWriting(databasePath, 'future');

    await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
      code: 'database_incompatible'
    });

    expect(await sizeOf(`${databasePath}-wal`)).toBe(0);
    const database = readOnly(databasePath);
    try {
      expect(database.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
        { version: 99 }
      );
    } finally {
      database.close();
    }
  });

  test('fails closed while another connection has the database open, then recovers', async () => {
    const databasePath = await path();
    await crashAfterWriting(databasePath, 'wal');
    const other = new Database(databasePath, { strict: true });
    try {
      expect(other.query('SELECT COUNT(*) AS count FROM model_preferences').get()).toEqual({
        count: 1
      });

      await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
        code: 'database_pending_journal'
      });

      expect(await sizeOf(`${databasePath}-wal`)).toBeGreaterThan(0);
      expect(other.query('SELECT COUNT(*) AS count FROM model_preferences').get()).toEqual({
        count: 1
      });
    } finally {
      other.close();
    }

    await expect(preflightDatabase(databasePath)).resolves.toEqual({
      state: 'compatible',
      maxVersion: 3
    });
  });

  test('discards a WAL without valid frames and leaves the database bytes unchanged', async () => {
    for (const fixture of ['history-only', 'canonical'] as const) {
      const databasePath = await path();
      if (fixture === 'canonical') await createCompatibleDatabase(databasePath);
      else await createSchemaHistory(databasePath, 1, 'registered');
      await Bun.write(`${databasePath}-wal`, 'pending-wal-canary');
      const before = await snapshot(databasePath);

      if (fixture === 'canonical') {
        await expect(preflightDatabase(databasePath)).resolves.toEqual({
          state: 'compatible',
          maxVersion: 3
        });
      } else {
        // Migration metadata without the schema it records.
        await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
          code: 'database_incompatible'
        });
      }

      expect(await snapshot(databasePath)).toEqual(before);
      expect(await sizeOf(`${databasePath}-wal`)).toBe(0);
    }
  });

  test('fails closed on a persistent rollback journal without changing any file', async () => {
    const databasePath = await path();
    await mkdir(join(databasePath, '..'), { recursive: true });
    const database = new Database(databasePath, { create: true, strict: true });
    try {
      database.exec('PRAGMA journal_mode = PERSIST;');
      migrateDatabase(database);
    } finally {
      database.close();
    }
    const journalPath = `${databasePath}-journal`;
    expect(await sizeOf(journalPath)).toBeGreaterThan(0);
    const before = await snapshot(databasePath);
    const beforeJournal = new Uint8Array(await Bun.file(journalPath).arrayBuffer());

    await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
      code: 'database_pending_journal'
    });

    expect(await snapshot(databasePath)).toEqual(before);
    expect(new Uint8Array(await Bun.file(journalPath).arrayBuffer())).toEqual(beforeJournal);
  });

  test('rejects a linked or special journal or index file without opening the database', async () => {
    for (const sidecar of ['-wal', '-shm', '-journal'] as const) {
      const databasePath = await path();
      await createCompatibleDatabase(databasePath);
      const target = `${databasePath}.elsewhere`;
      await Bun.write(target, 'not-a-journal');
      await symlink(target, `${databasePath}${sidecar}`, 'file');
      const before = await snapshot(databasePath);

      await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
        code: 'database_not_regular'
      });

      expect(await snapshot(databasePath)).toEqual(before);
      expect(await Bun.file(target).text()).toBe('not-a-journal');
    }

    // A FIFO reports size 0, so a size check alone would pass it.
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    expect(Bun.spawnSync(['mkfifo', `${databasePath}-shm`]).exitCode).toBe(0);
    await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
      code: 'database_not_regular'
    });
  });

  test('rejects non-SQLite bytes with a WAL beside them without touching either', async () => {
    const databasePath = await path();
    await mkdir(join(databasePath, '..'), { recursive: true });
    await Bun.write(databasePath, 'not-a-sqlite-database');
    await Bun.write(`${databasePath}-wal`, 'pending-wal-canary');
    const before = await snapshot(databasePath);

    await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
      code: 'database_unknown'
    });

    expect(await snapshot(databasePath)).toEqual(before);
    expect(await Bun.file(`${databasePath}-wal`).text()).toBe('pending-wal-canary');
    expect(await Bun.file(`${databasePath}-shm`).exists()).toBe(false);
  });

  test('rejects unknown non-SQLite bytes without rewriting them', async () => {
    const databasePath = await path();
    await mkdir(join(databasePath, '..'), { recursive: true });
    await Bun.write(databasePath, 'not-a-sqlite-database');
    const before = await snapshot(databasePath);

    await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
      code: 'database_unknown'
    });
    expect(await snapshot(databasePath)).toEqual(before);
  });

  test('rejects a database symlink without touching its target or creating sidecars', async () => {
    const target = await path();
    await createCompatibleDatabase(target);
    const link = `${target}-link`;
    await symlink(target, link, 'file');
    const before = await snapshot(target);

    await expect(preflightDatabase(link)).rejects.toMatchObject({ code: 'database_not_regular' });

    expect(await snapshot(target)).toEqual(before);
    expect(await Bun.file(`${link}-wal`).exists()).toBe(false);
    expect(await Bun.file(`${link}-shm`).exists()).toBe(false);
  });

  test('rejects an unrelated valid SQLite database without modifying it', async () => {
    const databasePath = await path();
    await mkdir(join(databasePath, '..'), { recursive: true });
    const database = new Database(databasePath, { create: true, strict: true });
    database.exec('CREATE TABLE unrelated(id INTEGER PRIMARY KEY, value TEXT);');
    database.close();
    const before = await snapshot(databasePath);

    await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
      code: 'database_unknown'
    });

    expect(await snapshot(databasePath)).toEqual(before);
    expect(await Bun.file(`${databasePath}-wal`).exists()).toBe(false);
    expect(await Bun.file(`${databasePath}-shm`).exists()).toBe(false);
  });
});
