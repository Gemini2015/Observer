import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** 数据目录不可写时的可操作错误信息（群晖/容器部署最常见问题）。 */
export function dataDirHint(dir: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'n/a';
  const gid = typeof process.getgid === 'function' ? process.getgid() : 'n/a';
  return (
    `data directory is not writable: ${dir} (running as uid=${uid}, gid=${gid}). ` +
    'Mount a writable volume for OBSERVER_DATA_DIR and make it writable by that uid/gid ' +
    '(Docker/NAS: `chown -R 1000:1000 <dir>`; or start the container as root with ' +
    'OBSERVER_FIX_DATA_PERMISSIONS=1 so the entrypoint fixes ownership before dropping privileges).'
  );
}

export function openDb(file: string): Db {
  let dir: string | undefined;
  if (file !== ':memory:') {
    dir = path.dirname(file);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new Error(
        `cannot create data directory ${dir}: ${(error as Error).message}. ${dataDirHint(dir)}`,
        { cause: error },
      );
    }
    try {
      fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      throw new Error(dataDirHint(dir));
    }
  }

  let db: Db;
  try {
    db = new Database(file);
  } catch (error) {
    throw new Error(
      `cannot open SQLite database ${file}: ${(error as Error).message}` +
        (dir ? `. ${dataDirHint(dir)}` : ''),
      { cause: error },
    );
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}
