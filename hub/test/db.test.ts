import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';

const opened: Array<ReturnType<typeof openDb>> = [];

afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.close();
  }
});

describe('openDb', () => {
  it('creates the data directory and opens the database', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'observer-db-')), 'nested', 'data');
    const db = openDb(path.join(dir, 'observer.db'));
    opened.push(db);

    expect(fs.existsSync(dir)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('supports in-memory databases without touching the filesystem', () => {
    const db = openDb(':memory:');
    opened.push(db);
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
  });

  it('reports the data directory when the path cannot be created', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'observer-db-')), 'blocker');
    fs.writeFileSync(file, 'not a directory');

    expect(() => openDb(path.join(file, 'child', 'observer.db'))).toThrow(/cannot create data directory/);
    expect(() => openDb(path.join(file, 'child', 'observer.db'))).toThrow(/data directory is not writable/);
  });
});
