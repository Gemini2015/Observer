import type { Db } from '../db/index.js';
import { hashPassword, verifyPassword } from '../util/password.js';

const SETTINGS_KEY = 'admin_password_hash';

/** 首次启动写入哈希；环境变量变化时轮换（env 是口令来源）。 */
export function ensureAdminPassword(db: Db, password: string): void {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(SETTINGS_KEY) as { value: string } | undefined;

  if (!row) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      SETTINGS_KEY,
      hashPassword(password),
    );
    return;
  }

  if (!verifyPassword(password, row.value)) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      hashPassword(password),
      SETTINGS_KEY,
    );
  }
}

export function verifyAdminPassword(db: Db, password: string): boolean {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(SETTINGS_KEY) as { value: string } | undefined;
  return row ? verifyPassword(password, row.value) : false;
}
