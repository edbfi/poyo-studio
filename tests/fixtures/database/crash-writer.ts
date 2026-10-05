// Used by tests/integration/database/preflight.test.ts. Writes to a database and then waits to be
// killed with SIGKILL while the connection is still open, as the app does when it is killed or its
// terminal is closed, so the WAL or rollback journal is left behind exactly as a crash leaves it.
//   wal:      opens the database as the app does (WAL mode, migrations) and commits one preference.
//   future:   as `wal`, and also commits a migration row from a newer app version.
//   rollback: opens an existing rollback-journal database and leaves a large transaction open, with a
//             tiny page cache so its pages spill into the main file before the commit.
import { Database } from 'bun:sqlite';
import { openDatabase } from '../../../src/lib/server/platform/database';

const [path, scenario] = process.argv.slice(2);
if (!path || !scenario) throw new Error('usage: crash-writer.ts <database> <wal|future|rollback>');

let database: Database;
if (scenario === 'rollback') {
  database = new Database(path, { strict: true });
  database.exec('PRAGMA cache_size = 2; PRAGMA cache_spill = 1; BEGIN IMMEDIATE;');
  const insert = database.query(
    'INSERT INTO model_preferences(entry_key, favorite, favorited_at, last_used_at) VALUES (?, 0, NULL, NULL)'
  );
  for (let row = 0; row < 2000; row += 1) insert.run(`uncommitted-${row}-${'x'.repeat(200)}`);
} else {
  database = await openDatabase(path);
  database
    .query(
      'INSERT INTO model_preferences(entry_key, favorite, favorited_at, last_used_at) VALUES (?, 1, ?, NULL)'
    )
    .run('committed-before-crash', '2026-10-05T00:00:00.000Z');
  if (scenario === 'future') {
    database
      .query(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)'
      )
      .run(99, 'future migration', 'future-checksum', '2026-10-05T00:00:00.000Z');
  }
}
console.log('ready');
// Keep the connection referenced and in use until the test kills this process.
setInterval(() => database.query('SELECT 1').get(), 200);
