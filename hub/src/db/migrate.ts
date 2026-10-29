import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export function migrate(db: Db, dir: string = MIGRATIONS_DIR): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number((row as { version: number }).version)),
  );

  const files = fs
    .readdirSync(dir)
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .sort();

  for (const file of files) {
    const version = Number(file.split('_')[0]);
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        Date.now(),
      );
    });
    apply();
  }
}
