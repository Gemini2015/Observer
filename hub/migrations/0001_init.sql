-- Observer hub 初始 schema（v1）
-- 约定：时间字段为 epoch 毫秒；mtime_ns 为十进制字符串（防 JS 精度丢失）。

CREATE TABLE machines (
  id INTEGER PRIMARY KEY,
  machine_id TEXT NOT NULL UNIQUE,
  label TEXT, hostname TEXT, platform TEXT, arch TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER,
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','offline'))
);

CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  machine_pk INTEGER NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  version TEXT, protocol INTEGER NOT NULL DEFAULT 1,
  capabilities_json TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);
CREATE INDEX idx_agents_machine ON agents(machine_pk);

CREATE TABLE mounts (
  id INTEGER PRIMARY KEY,
  machine_pk INTEGER NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  mount_id TEXT NOT NULL, label TEXT, physical_path TEXT NOT NULL,
  sentinel TEXT,
  fs_kind TEXT NOT NULL DEFAULT 'local'
    CHECK (fs_kind IN ('local','network','removable','fuse')),
  case_sensitive TEXT NOT NULL DEFAULT 'auto'
    CHECK (case_sensitive IN ('auto','true','false')),
  unicode TEXT NOT NULL DEFAULT 'auto'
    CHECK (unicode IN ('auto','nfc','nfd')),
  include_json TEXT NOT NULL DEFAULT '[]',
  exclude_json TEXT NOT NULL DEFAULT '[]',
  rules_hash TEXT NOT NULL,
  limits_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','unavailable','suspect','removed')),
  manifest_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (machine_pk, mount_id)
);

CREATE TABLE paths (
  id INTEGER PRIMARY KEY,
  mount_pk INTEGER NOT NULL REFERENCES mounts(id) ON DELETE RESTRICT,
  path_key TEXT NOT NULL,
  path_display BLOB NOT NULL,
  size INTEGER NOT NULL,
  mtime_ns TEXT NOT NULL,
  content_hash TEXT,
  volume_id TEXT,
  last_seen_job_pk INTEGER,
  last_seen_at INTEGER,
  last_hashed_at INTEGER,
  last_hash_kind TEXT CHECK (last_hash_kind IN ('hash','skip')),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','missing','out_of_scope')),
  change_epoch INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (mount_pk, path_key)
);
CREATE INDEX idx_paths_hash ON paths(content_hash);
CREATE INDEX idx_paths_cover ON paths(mount_pk, state, last_hashed_at);
CREATE INDEX idx_paths_missing ON paths(mount_pk, last_seen_job_pk);
CREATE INDEX idx_paths_delta ON paths(mount_pk, change_epoch);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY,
  path_pk INTEGER NOT NULL REFERENCES paths(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  algo TEXT NOT NULL DEFAULT 'sha256',
  kind TEXT NOT NULL CHECK (kind IN ('baseline','scan','repair')),
  observed_at INTEGER NOT NULL
);
CREATE INDEX idx_obs_path ON observations(path_pk, observed_at);
CREATE INDEX idx_obs_time ON observations(observed_at);

CREATE TABLE scan_jobs (
  id INTEGER PRIMARY KEY,
  mount_pk INTEGER NOT NULL REFERENCES mounts(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('baseline','incremental','full')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','canceled','expired')),
  rules_hash TEXT NOT NULL,
  lease_until INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER, finished_at INTEGER,
  stats_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_queue ON scan_jobs(status, created_at);
CREATE INDEX idx_jobs_lease ON scan_jobs(status, lease_until);
CREATE UNIQUE INDEX uq_jobs_active ON scan_jobs(mount_pk)
  WHERE status IN ('pending','running');

CREATE TABLE scan_batches (
  job_pk INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (job_pk, seq)
);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY,
  path_pk INTEGER NOT NULL REFERENCES paths(id) ON DELETE CASCADE,
  mount_pk INTEGER NOT NULL REFERENCES mounts(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('mismatch','missing','unreadable')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acked','ignored','resolved')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  evidence_json TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (path_pk, type)
);
CREATE INDEX idx_issues_status ON issues(status, last_seen_at);
CREATE INDEX idx_issues_mount ON issues(mount_pk, status);

CREATE TABLE enroll_tokens (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  machine_hint TEXT,
  expires_at INTEGER NOT NULL, used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT, detail_json TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX idx_audit_time ON audit_log(at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);

INSERT INTO settings (key, value)
VALUES ('db_instance_id', lower(hex(randomblob(16))));
