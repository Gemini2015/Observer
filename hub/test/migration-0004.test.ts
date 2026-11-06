import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { MIGRATIONS_DIR, migrate } from '../src/db/migrate.js';

let db: Db | undefined;
let dir: string | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('migration 0004', () => {
  it('maps acked to ignored and backfills ignored hash/at', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-migrate-'));
    for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
      if (/^000[1-3]_.*\.sql$/.test(file)) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
      }
    }

    db = openDb(':memory:');
    migrate(db, dir);

    const now = 1_700_000_000_000;
    db.prepare("INSERT INTO machines (machine_id, created_at) VALUES ('m1', ?)").run(now);
    db.prepare(
      `INSERT INTO mounts (machine_pk, mount_id, physical_path, rules_hash, created_at, updated_at)
       VALUES (1, 'drv', '/data', 'rules', ?, ?)`,
    ).run(now, now);
    const insertPath = db.prepare(
      `INSERT INTO paths
         (mount_pk, path_key, path_display, size, mtime_ns, content_hash, state, change_epoch, updated_at)
       VALUES (1, ?, X'61', 1, '1', 'trusted', 'active', 0, ?)`,
    );
    insertPath.run('acked-mismatch.txt', now);
    insertPath.run('acked-unreadable.txt', now);
    insertPath.run('ignored-mismatch.txt', now);
    insertPath.run('ignored-bad-evidence.txt', now);

    const insertObservation = db.prepare(
      "INSERT INTO observations (path_pk, hash, algo, kind, observed_at) VALUES (?, ?, 'sha256', 'scan', ?)",
    );
    insertObservation.run(3, 'observed-from-observation', now);

    const insertIssue = db.prepare(
      `INSERT INTO issues
         (path_pk, mount_pk, type, status, confidence, evidence_json, occurrences,
          first_seen_at, last_seen_at, resolved_at)
       VALUES (?, 1, ?, ?, 'high', ?, 1, ?, ?, NULL)`,
    );
    insertIssue.run(
      1,
      'mismatch',
      'acked',
      JSON.stringify({ trusted_hash: 'trusted', observed_hash: 'acked-observed' }),
      now,
      now,
    );
    insertIssue.run(2, 'unreadable', 'acked', null, now, now);
    insertIssue.run(3, 'mismatch', 'ignored', null, now, now);
    insertIssue.run(4, 'mismatch', 'ignored', '{bad json', now, now);

    fs.copyFileSync(
      path.join(MIGRATIONS_DIR, '0004_issue_accept_ignore.sql'),
      path.join(dir, '0004_issue_accept_ignore.sql'),
    );
    migrate(db, dir);

    const rows = db
      .prepare(
        `SELECT type, status, ignored_hash, ignored_at, resolution
           FROM issues ORDER BY id`,
      )
      .all() as Array<{
      type: string;
      status: string;
      ignored_hash: string | null;
      ignored_at: number | null;
      resolution: string | null;
    }>;

    expect(rows[0]).toMatchObject({
      type: 'mismatch',
      status: 'ignored',
      ignored_hash: 'acked-observed',
      ignored_at: now,
      resolution: null,
    });
    expect(rows[1]).toMatchObject({
      type: 'unreadable',
      status: 'ignored',
      ignored_hash: null,
      ignored_at: now,
      resolution: null,
    });
    expect(rows[2]).toMatchObject({
      type: 'mismatch',
      status: 'ignored',
      ignored_hash: 'observed-from-observation',
      ignored_at: now,
      resolution: null,
    });
    expect(rows[3]).toMatchObject({
      type: 'mismatch',
      status: 'ignored',
      ignored_hash: null,
      ignored_at: now,
      resolution: null,
    });
  });
});
