-- M3：副本关联与跨机修复。

ALTER TABLE mounts ADD COLUMN repair_allowed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE repair_jobs (
  id INTEGER PRIMARY KEY,
  issue_pk INTEGER NOT NULL REFERENCES issues(id) ON DELETE RESTRICT,
  source_path_pk INTEGER NOT NULL REFERENCES paths(id) ON DELETE RESTRICT,
  target_path_pk INTEGER NOT NULL REFERENCES paths(id) ON DELETE RESTRICT,
  expected_hash TEXT NOT NULL,
  observed_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','transferring','ready','applying','completed','failed','canceled')),
  error TEXT,
  quarantine_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_repairs_status ON repair_jobs(status, updated_at);

CREATE TABLE transfer_tickets (
  id INTEGER PRIMARY KEY,
  repair_pk INTEGER NOT NULL REFERENCES repair_jobs(id) ON DELETE CASCADE,
  source_path_pk INTEGER NOT NULL REFERENCES paths(id) ON DELETE RESTRICT,
  expected_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ready','failed','expired','completed')),
  bytes_received INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_transfers_status ON transfer_tickets(status, expires_at);
